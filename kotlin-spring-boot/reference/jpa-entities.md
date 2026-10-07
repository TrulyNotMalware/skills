# JPA entities and repositories in Kotlin

Spring Boot 4 manages Jakarta Persistence 3.2 and Hibernate ORM 7. Import `jakarta.persistence.*`,
never `javax.persistence.*`. Do not declare Hibernate or JPA versions; let the Boot BOM manage them.

Contents: [Required build setup](#required-build-setup) · [Entity shape](#entity-shape) ·
[Embeddables and value types](#embeddables-and-value-types) · [Relationships](#relationships) ·
[equals and hashCode](#equals-and-hashcode) · [Repositories](#repositories) ·
[N+1 queries](#n1-queries) · [Bulk updates and versioning](#bulk-updates-and-versioning) ·
[Batch writes](#batch-writes) · [New-entity detection](#new-entity-detection) ·
[Separate domain and persistence models](#separate-domain-and-persistence-models) ·
[Schema changes](#schema-changes) · [Testing persistence](#testing-persistence) ·
[Gotchas](#gotchas)

## Required build setup

See [kotlin-spring-basics](kotlin-spring-basics.md#build-setup-gradle-kotlin-dsl). `plugin.jpa`
generates no-arg constructors and, since Kotlin 2.3.20, also opens `Entity`/`MappedSuperclass`/
`Embeddable` classes. Older Kotlin needs an explicit `allOpen` block. If entity classes end up final,
Hibernate cannot create lazy proxies for to-one associations, and lazy loading quietly becomes eager
or fails. Verify with `javap -p` on a compiled entity when unsure.

## Entity shape

```kotlin
@Entity
@Table(
    name = "orders",
    indexes = [Index(name = "idx_orders_status_created", columnList = "status, created_at")],
)
class Order(
    @field:Column(name = "customer_id", nullable = false, updatable = false)
    val customerId: UUID,
    @field:Column(name = "created_at", nullable = false, updatable = false)
    val createdAt: Instant,
) {
    @field:Id
    @field:GeneratedValue(strategy = GenerationType.UUID)
    var id: UUID? = null
        protected set

    @field:Version
    var version: Long? = null
        protected set

    @field:Enumerated(EnumType.STRING)
    @field:Column(nullable = false, length = 32)
    var status: OrderStatus = OrderStatus.DRAFT
        protected set

    @field:OneToMany(mappedBy = "order", cascade = [CascadeType.ALL], orphanRemoval = true)
    protected val mutableItems: MutableList<OrderItem> = mutableListOf()
    val items: List<OrderItem> get() = mutableItems.toList()

    fun addItem(productId: UUID, quantity: Int, unitPrice: Money) {
        check(status == OrderStatus.DRAFT) { "Cannot edit order $id in status $status" }
        mutableItems += OrderItem(this, productId, quantity, unitPrice)
    }

    fun submit() {
        check(mutableItems.isNotEmpty()) { "Cannot submit empty order" }
        status = OrderStatus.SUBMITTED
    }
}
```

Rules:

- **`class`, never `data class`.** Generated `equals`/`hashCode` use all constructor properties
  (mutable, possibly lazy), `toString` walks associations and can trigger lazy loads or recursion,
  and `copy()` produces a second instance with the same identity that Hibernate does not track.
- **Mutable state uses `var` with `protected set`.** The JPA all-open preset makes properties open, and an open
  property cannot have a `private set` (compile error). `protected set` is the narrowest legal choice.
- **Immutable columns are constructor `val`s** with `updatable = false` where appropriate.
- **Kotlin nullability must match the column.** A non-null `String` mapped to a nullable column
  compiles, but Hibernate sets the field to `null` via reflection when a row has `NULL`. The
  resulting NPE appears far from the load. Map legacy nullable columns as nullable types.
- The `plugin.jpa` no-arg constructor does not run property initializers (unless the build sets
  `noArg { invokeInitializers = true }`). Hibernate overwrites mapped fields on load, so this is
  normally harmless, but never put logic in `init` blocks or unmapped initialized fields that a
  loaded entity relies on.
- Generated ID: `var id: T? = null` with `protected set`. Do not use `lateinit` for IDs or
  columns; `lateinit` cannot be checked cheaply from outside and does not work with primitives.
- Collections: expose a read-only view; keep the mutable list `protected` and initialized.
  Never reassign a mapped collection; mutate it.
- `@Enumerated(EnumType.STRING)` with an explicit length. Never `ORDINAL`.
- `@Version var version: Long? = null` on aggregates that users edit concurrently. Use the nullable
  wrapper: Spring Data uses a null version to detect new entities.
- Behavior methods (`submit()`, `addItem()`) enforce invariants with `check`/`require`. Do not expose
  public setters.
- Timestamps: `@CreationTimestamp`/`@UpdateTimestamp` use the JVM clock, not an injected `Clock`.
  If tests or time zones matter, set the value from a `Clock` in the service instead. Keep
  `Instant` vs `LocalDateTime` consistent with the existing schema; mixing zones across components
  shifts cutoffs by the zone offset.

## Embeddables and value types

```kotlin
@Embeddable
class Money(
    @field:Column(name = "amount", nullable = false, precision = 19, scale = 2)
    val amount: BigDecimal,
    @field:Column(name = "currency", nullable = false, length = 3)
    val currency: String,
) {
    init { require(amount.signum() >= 0) { "Amount cannot be negative" } }

    operator fun plus(other: Money): Money {
        require(currency == other.currency) { "Currency mismatch" }
        return Money(amount + other.amount, currency)
    }

    override fun equals(other: Any?) =
        other is Money && amount.compareTo(other.amount) == 0 && currency == other.currency
    override fun hashCode() = 31 * amount.stripTrailingZeros().hashCode() + currency.hashCode()
}
```

- A plain `class` with hand-written value equality is the safe default. A `data class` embeddable
  also works with `plugin.jpa`, but `BigDecimal` equality in the generated `equals` is scale-sensitive
  (`1.0 != 1.00`).
- Kotlin `@JvmInline value class` properties compile to the underlying type in some positions and
  to the boxed class in others (nullable, generic). JPA mapping of them is not documented; unwrap
  in the entity or use an `AttributeConverter`, and check the generated column mapping.

## Relationships

```kotlin
@Entity
class OrderItem(
    @field:ManyToOne(fetch = FetchType.LAZY, optional = false)
    @field:JoinColumn(name = "order_id", nullable = false)
    val order: Order,
    @field:Column(name = "product_id", nullable = false)
    val productId: UUID,
    @field:Column(nullable = false)
    val quantity: Int,
    @field:Embedded
    val unitPrice: Money,
) {
    @field:Id
    @field:GeneratedValue(strategy = GenerationType.UUID)
    var id: UUID? = null
        protected set
}
```

- Put `fetch = FetchType.LAZY` on every `@ManyToOne` and `@OneToOne`; to-one is eager by default.
- Add `@OneToMany(mappedBy = ...)` only when the parent really navigates to children. When both
  sides exist, update both inside one domain method (`addItem` above constructs the child with its
  parent and adds it). Only the **owning** side (the `@ManyToOne` / join column) controls the foreign
  key. Adding a child only to the inverse `mappedBy` collection persists nothing. Setting only the
  owning side persists correctly, but the in-memory collection stays stale until reload.
- Avoid `Set` collections of entities whose `equals`/`hashCode` depend on mutable state or a
  not-yet-generated ID. Membership breaks after persist or mutation.
- Use `orphanRemoval = true` only when the parent owns the child lifecycle.
- Model many-to-many links that carry attributes as their own entity.
- Do not serialize entities to JSON. Map to DTOs inside the transaction.
- Set `spring.jpa.open-in-view=false`. Boot enables it by default (with a startup warning), which
  hides lazy-loading outside the service layer until production load exposes it.

## equals and hashCode

- Default: keep object identity (no override) unless the entity is placed in hash-based collections
  across persistence contexts.
- Natural key (unique, immutable, e.g. an external ID) → base equality on it and enforce a unique
  constraint.
- Generated ID only → ID equality that does not initialize proxies:

```kotlin
// inside the entity class
final override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other == null || effectiveClass(this) != effectiveClass(other)) return false
    other as Order
    return id != null && id == other.id
}

final override fun hashCode(): Int = effectiveClass(this).hashCode()

// file level, shared by entities
internal fun effectiveClass(o: Any): Class<*> =
    if (o is HibernateProxy) o.hibernateLazyInitializer.persistentClass else o.javaClass
```

Verified on Hibernate 7.4.5 against a **detached, uninitialized** proxy: equal in both directions,
same hash, proxy stays uninitialized. Do not use `Hibernate.getClass()` or `Hibernate.getClassLazy()`
here. Both need a session to resolve the real class of an uninitialized proxy and throw
`LazyInitializationException` ("could not retrieve real entity class ... no Session") once it is
detached. `final` keeps the proxy subclass from overriding the methods. Reading `other.id` on a proxy
returns the identifier without initializing it.

Never include collections, associations, or mutable fields in `equals`, `hashCode`, or `toString`.

## Repositories

```kotlin
interface OrderRepository : JpaRepository<Order, UUID> {
    fun findByIdAndCustomerId(id: UUID, customerId: UUID): Order?

    fun existsByCustomerIdAndStatus(customerId: UUID, status: OrderStatus): Boolean

    @EntityGraph(attributePaths = ["mutableItems"])
    fun findWithItemsById(id: UUID): Order?

    @Query(
        """
        select o from Order o
        where o.status = :status
          and (o.createdAt < :lastCreatedAt or (o.createdAt = :lastCreatedAt and o.id < :lastId))
        order by o.createdAt desc, o.id desc
        """,
    )
    fun findNextPage(status: OrderStatus, lastCreatedAt: Instant, lastId: UUID, limit: Limit): List<Order>
}
```

- Nullable return types instead of `Optional`. For `findById`, use `findByIdOrNull(id)`.
- Attribute paths and JPQL use the **mapped property name**. With the read-only-view pattern above,
  that is the backing collection (`mutableItems`), not the public getter.
- `exists...` queries instead of `find...() != null` for existence checks.
- No `findAll()` in request paths. Require `Pageable`, `Limit`, or a projection query.
- Keyset pagination (`(createdAt, id)` cursor) for deep or infinite lists. `OFFSET` scans and
  discards skipped rows. Back it with an index matching the order.
- Projections (interfaces or Kotlin data class DTOs via constructor expressions) for read-only
  list views.

## N+1 queries

Look for lazy association access in loops, in `map { }` over entity lists, and in DTO mapping. Fix
with `@EntityGraph` or `join fetch` for bounded graphs, or with a projection for lists.

- **A paged query that join-fetches a collection depends on the Hibernate version** (`join fetch`,
  or an `@EntityGraph` on a paged repository method; observed with Spring Data `Pageable` on H2 and
  PostgreSQL 17). Batch fetching (`@BatchSize`) after a paged parent query is a different mechanism.
  - Up to 7.3 (7.3.13 run), Hibernate loads every matching row and paginates in memory, logging
    HHH90003004. It throws instead when `hibernate.query.fail_on_pagination_over_collection_fetch=true`.
  - From 7.4 (7.4.0, 7.4.5 and 7.4.11 run; Boot 4.1.1 manages 7.4.5), it moves offset and limit into
    a derived table over the root entity by default. Plain `join fetch` and `left join fetch`,
    `@EntityGraph` on a paged derived query, `distinct`, `Slice` and `Limit` all page in SQL and return
    complete collections, with no warning. It still pages in memory (warning or fail setting as above)
    when the `order by` references the fetched collection or contains a correlated subquery, and (from
    source, not run) when the `org.hibernate.limitInMemory` hint is set or the dialect lacks
    offset-in-subquery support, such as Sybase.
  - Where 7.4 applies the rewrite, three shapes that 7.3 paged in memory broke in the runs. A `where`
    on the fetch alias is an SQL grammar error (`missing FROM-clause entry`). A second join to the same
    collection without `distinct` (`join o.items x join fetch o.items where x.sku in ...`) silently
    returns wrong pages and totals (7.3 paged the same query correctly), and a `List` can hold
    duplicated children (on 7.3 as well); `select distinct o` fixes both. A correlated scalar subquery
    in the select list (`select o, (select count(...) ...) from Order o join fetch o.items`) silently
    returns duplicate parents with truncated collections.
  - The count query of a `Page` must count the same parents as the content: same filters and join
    semantics, without the fetch, and `count(distinct o)` when a join can repeat a parent. A mismatch
    shows up as a wrong `totalElements` and `hasNext` on full pages while the content is right (Spring
    Data skips the count query on a short last page, so the last page looks correct).
  - The version-independent alternative: page a query that returns one row per parent (IDs, a stable
    sort), then fetch the graph `where o.id in :ids` without paging and restore the ID order in code
    (`in` does not preserve it). The ID query's filter must match the fetch's join: an ID without
    children has no row in an inner `join fetch` (below, `getValue` then throws). Use it below 7.4 and
    for any of the shapes above (run on 7.3.13 and 7.4.5, H2 and PostgreSQL).

    ```kotlin
    @Query("select o.id from Order o where o.customerId = :customerId and exists (select 1 from OrderItem i where i.order = o)",
        countQuery = "select count(o) from Order o where o.customerId = :customerId and exists (select 1 from OrderItem i where i.order = o)")
    fun findIdsWithItems(customerId: Long, pageable: Pageable): Page<Long>
    @Query("select distinct o from Order o join fetch o.items where o.id in :ids")
    fun findWithItemsByIdIn(ids: Collection<Long>): List<Order>
    // service
    @Transactional(readOnly = true)
    fun pageWithItems(customerId: Long, pageable: Pageable): Page<Order> {
        val ids = orders.findIdsWithItems(customerId, pageable)
        val byId = if (ids.hasContent()) orders.findWithItemsByIdIn(ids.content).associateBy { it.id!! } else emptyMap()
        return ids.map { byId.getValue(it) }
    }
    ```
- Fetching two collections at once produces a cartesian product (and `MultipleBagFetchException` for
  `List`s). Fetch one collection per query.
- **Do not filter on a fetched collection's alias.** `join fetch o.mutableItems i where i.status = 'OPEN'`
  loads each order with only the matching items, without a warning, and that truncated collection is
  what the persistence context holds: later code in the same transaction (`order.items.size`, a DTO
  mapping, even a later unfiltered fetch of the same order) sees the wrong children (Hibernate 7.4, H2
  and PostgreSQL). Filter with `exists (select 1 from OrderItem x where x.order = o and ...)` and fetch the
  collection unfiltered, or query the children directly.
- **`join fetch` is an inner join.** Parents without children disappear from the result. Use
  `left join fetch` unless an empty collection should exclude the parent.
- In tests, assert collection sizes, not only presence; a truncated collection still "contains" the
  expected element.

## Bulk updates and versioning

- `@Modifying` JPQL `update`/`delete` bypass the persistence context and do **not** increment
  `@Version`. Increment it in the query if concurrent editors must see the conflict.
- `@Modifying(clearAutomatically = true)` detaches every managed entity. Anything pending on them is
  lost, including a `LockModeType.OPTIMISTIC_FORCE_INCREMENT` bump scheduled for commit (seen on
  Hibernate 7.4: the row updated, version unchanged). Do not combine the two in one transaction; run the
  bulk statement in its own unit or re-read afterwards.
- `@Modifying(flushAutomatically = true)` flushes pending entity changes before the bulk statement.
  Use it with `clearAutomatically` when earlier writes in the same transaction must not be lost.
  It does not rescue commit-time actions such as the forced version increment above.

## Batch writes

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc.batch_size: 50
        order_inserts: true
        order_updates: true
```

`GenerationType.IDENTITY` disables insert batching because Hibernate needs each generated key.
Use UUIDs or pooled sequences on write-heavy tables.

## New-entity detection

Spring Data's `save()` calls `persist` for new entities and `merge` otherwise. If the entity has a
`@Version` of a nullable (wrapper) type, a null version means new, and the ID is never consulted.
Only without such a version does it check for a null ID. A primitive-typed version does not count.
An application-assigned ID (`val id: UUID = UUID.randomUUID()`) without `@Version` looks "not new". `save()` then merges, which costs an extra `SELECT` and can
silently overwrite an existing row. Add `@Version var version: Long? = null`, or implement
`Persistable<ID>` with a transient `isNew` flag cleared in `@PostPersist`/`@PostLoad`.

When `save()` merges, it returns a **different, managed instance**; the argument stays detached.
Always continue with the return value (`val saved = repository.save(order)`). Changes made to the
original object after the call are not tracked.

## Separate domain and persistence models

Applies when the project keeps a framework-free domain model and maps it to separate JPA classes in
an infrastructure layer (common in hexagonal or "clean" layouts). The examples above assume the
entity is the aggregate; do not introduce a second model into a project that does not have one.

- **Loading must not re-run creation rules.** Constructors and factories often validate input against
  "now" or other creation-time policy (`startAt` must be in the future). Mapping a stored row back
  through the same constructor rejects or alters valid old data. Give the domain type a separate
  reconstitution path that only checks structural invariants.
- **Keep the version in the round trip.** When load and save run in separate transactions (read →
  domain change → save), a save that re-reads the row and copies the domain fields onto it checks the
  **fresh** version, so a change made in between is overwritten silently. Carry the version in the
  domain object and make the save fail on a mismatch (put it on the detached entity passed to
  `repository.save()`, which then throws `ObjectOptimisticLockingFailureException`; a raw
  `EntityManager.merge` throws `jakarta.persistence.OptimisticLockException`), or keep load and save
  in one transaction on the managed entity. Setting the old version on a re-read **managed** entity does
  not help: Hibernate checks the version it loaded. A bulk `update` query skips the version entirely
  ([bulk updates](#bulk-updates-and-versioning)).
- Map inside the transaction. Mapping that walks lazy associations after the transaction ends fails
  with `LazyInitializationException`, or only works while a `join fetch` happens to be present.
- One mapping per direction, tested per direction. Two mappers for the same type (to domain, to a DTO)
  drift apart; a field defaulted in one (`reason = ""`) and copied in the other changes behavior by
  call path.
- Enforce the boundary in the build: the domain module declares no framework dependencies, and an
  architecture test (ArchUnit, Konsist) or a classpath check guards it
  ([gradle-build](gradle-build.md#multi-module-structure)).

## Schema changes

Migration tools (Flyway, Liquibase) are out of scope here; these rules hold with any of them.

- `spring.jpa.hibernate.ddl-auto=update` never drops tables or columns and does not report unmapped
  ones. It does alter column types on Hibernate 7.4: a shortened `length` is applied with
  `alter column ... set data type`, and if existing rows do not fit, the statement fails with only a
  WARN log and startup continues (retried on every start). Where migrations manage the schema, use
  `validate` (or `none`). `validate` fails startup on a missing table or column or a wrong column type,
  but not on an extra column or a different length.
- Native SQL written for one engine (`INSERT IGNORE`, `ON CONFLICT`, `RETURNING`, JSON functions)
  must be tested on that engine. H2 rejects or emulates much of it differently.
- Pass enum and status values to native SQL as bound parameters (`:status` with `Status.SENDING.name`),
  not as string literals in the query. Renaming the enum constant then fails to compile where it is
  used, instead of leaving `'SENDING'` silently matching nothing.
- An index declared in `@Table(indexes = ...)` exists only where Hibernate generates the schema; a
  migration-managed database needs it in a migration too.

## Testing persistence

- Use the production database engine via Testcontainers for anything involving locking, isolation,
  JSON columns, or time zones. H2 shares the JVM clock and dialect shortcuts that hide real bugs.
- With Kotest specs in the default `SpringTestLifecycleMode.Test`, Spring's test transaction wraps
  only the leaf test, not `given`/`when` container blocks (`SpringTestLifecycleMode.Root` changes
  the unit to the root test; follow the project's setting). `TestEntityManager.flush()` inside a container block fails with
  "No transactional EntityManager found", and `save()` followed by a query there runs in separate
  transactions. Wrap such steps in `TransactionTemplate` when the first-level cache, locks, or lazy
  loading matter to the assertion.

## Gotchas

- Agent writes a `data class` entity - use a regular class with explicit identity rules.
- Agent writes `private set` on an entity property - compile error once entities are opened; use `protected set`.
- Agent omits `allOpen` on Kotlin older than 2.3.20 - entities stay final and lazy to-one
  associations cannot be proxied. (Adding one on 2.3.20+ is redundant, not wrong.)
- Agent keeps mutating the object passed to `save()` - after a merge, only the returned instance is managed.
- Agent adds a child only to the inverse (`mappedBy`) collection - no foreign key is written.
- Agent maps a nullable column to a non-null Kotlin type - NPE surfaces later, not at load.
- Agent assigns UUIDs in the constructor without `@Version` - `save()` merges instead of persisting.
- Agent references the public read-only getter in `@EntityGraph`/JPQL - use the mapped field name.
- Agent combines `clearAutomatically = true` with pending version bumps - the bump is dropped.
- Agent leaves `open-in-view` enabled - lazy loads leak into controllers and serialization.
- Agent join-fetches a collection in a paged query - below Hibernate 7.4 pagination happens in memory. On 7.4 an `order by` on the collection still pages in memory, and a `where` on the fetch alias, a second join to the collection without `distinct`, or a correlated scalar subquery in the select list fails or returns wrong pages.
- Agent filters on a `join fetch` alias in `where` - the managed collection is truncated; use `exists`.
- Agent uses `join fetch` where a parent may have no children - those parents vanish; use `left join fetch`.
- Agent maps a stored row back through the domain's creation constructor - creation-time checks reject old data.
- Agent saves a domain object by re-reading the row and copying fields onto it - the fresh version is checked and a concurrent change is overwritten.
- Agent writes enum values as string literals in native SQL - a rename compiles and the query silently matches nothing.
