#!/usr/bin/env python3
"""Check a skill directory: relative links/anchors resolve, SKILL.md frontmatter exists, description
fits the Agent Skills limit, table rows keep their column count, no stray .omc/, and nothing that belongs
to one machine or one project (home directory paths, e-mail addresses, the author's wiki, names listed in
scripts/private-terms.txt). Warns (without failing) about long references without contents.
With no arguments it checks every skill and also runs the private scan over the top-level *.md files and
the mods/ sources, so it is the pre-publish check for the whole repository."""
import glob, os, re, sys

DESCRIPTION_MAX = 1024  # Agent Skills specification limit
TOC_MIN_LINES = 100     # references longer than this should list their contents near the top
PRIVATE_TERMS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "private-terms.txt")

# Never in anything published: this machine's home directory (tests may use a made-up one), an e-mail
# address (example.* allowed).
PRIVATE_ANYWHERE = [
    (re.escape(os.path.expanduser("~")) + r"(?![\w.-])", "home directory path"),
    (r"[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "e-mail address"),
]
# Never in a skill, which states general practice: paths and tools of the author's machine.
PRIVATE_IN_SKILLS = PRIVATE_ANYWHERE + [
    (r"~/workspace\b", "path on the author's machine"),
    (r"~/infra\b", "path on the author's machine"),
    (r"llm_wiki", "the author's wiki"),
]
MOD_SOURCE_SUFFIXES = (".ts", ".tsx", ".json", ".md")

def description(skill_md):
    """Frontmatter description as YAML would fold it (plain, quoted, or `>` block)."""
    lines = open(skill_md, encoding="utf-8").read().split("\n")
    end = lines.index("---", 1) if "---" in lines[1:] else len(lines)
    for i, line in enumerate(lines[1:end], 1):
        m = re.match(r"^description:\s*(.*)$", line)
        if not m:
            continue
        value = m.group(1).strip()
        if value[:1] in (">", "|"):
            block = []
            for nxt in lines[i + 1:end]:
                if nxt and not nxt.startswith(" "):
                    break
                block.append(nxt.strip())
            sep = " " if value[0] == ">" else "\n"
            text = sep.join(b for b in block if b)
            return text + "\n" if value in (">", "|") else text  # clip chomping keeps the final newline
        return value.strip("'\"")
    return None

def prose_lines(path):
    """Lines outside fenced code blocks: code such as a Go generic call `f[T](x)` or a `# comment` is not
    Markdown, so it must not count as a link or a heading."""
    fence = None
    for line in open(path, encoding="utf-8").read().split("\n"):
        m = re.match(r"^\s*(```|~~~)", line)
        if m:
            fence = None if fence == m.group(1) else (fence or m.group(1))
            continue
        if fence is None:
            yield line

def anchors(path):
    out = set()
    for line in prose_lines(path):
        m = re.match(r"^(#{1,6})\s+(.*)", line)
        if m:
            t = re.sub(r"[`*]", "", m.group(2).strip().lower())
            t = re.sub(r"[^\w\s-]", "", t).replace(" ", "-")
            out.add(t)
    return out

def private_terms():
    """(pattern, label) per non-comment line of private-terms.txt; empty when the file is absent."""
    if not os.path.exists(PRIVATE_TERMS_FILE):
        return []
    out = []
    for line in open(PRIVATE_TERMS_FILE, encoding="utf-8"):
        term = line.split("#", 1)[0].strip()
        if term:
            out.append((re.escape(term), "private term (see scripts/private-terms.txt)"))
    return out

def private_scan(files, patterns):
    """Lines that name a machine, a person or a private project. Terms are matched case-insensitively."""
    problems = []
    checks = [(p, label, 0) for p, label in patterns] + [(p, label, re.I) for p, label in private_terms()]
    for f in files:
        for n, line in enumerate(open(f, encoding="utf-8", errors="replace").read().split("\n"), 1):
            for pattern, label, flags in checks:
                m = re.search(pattern, line, flags)
                if m:
                    problems.append(f"{f}:{n}: {label}: {m.group(0)}")
    return problems

def check(skill_dir):
    problems = []
    skill_md = os.path.join(skill_dir, "SKILL.md")
    if not os.path.exists(skill_md):
        return [f"missing {skill_md}"]
    head = open(skill_md, encoding="utf-8").read(2000)
    if not head.startswith("---") or "\nname:" not in head or "\ndescription:" not in head:
        problems.append("SKILL.md frontmatter needs name and description")
    desc = description(skill_md)
    if desc is not None and len(desc) > DESCRIPTION_MAX:
        problems.append(f"SKILL.md description is {len(desc)} characters (limit {DESCRIPTION_MAX})")
    files = [skill_md] + sorted(glob.glob(os.path.join(skill_dir, "reference", "*.md")))
    for f in files:
        text = "\n".join(re.sub(r"`[^`\n]*`", "``", line) for line in prose_lines(f))  # drop inline code
        for m in re.finditer(r"\]\(([^)#\s]*)(#[^)\s]*)?\)", text):
            target, anc = m.group(1), m.group(2)
            if target.startswith("http"):
                continue
            tp = os.path.normpath(os.path.join(os.path.dirname(f), target)) if target else f
            if not os.path.exists(tp):
                problems.append(f"{f}: missing file {target}")
            elif anc and anc[1:] not in anchors(tp):
                problems.append(f"{f}: bad anchor {target}{anc}")
    for f in files:
        prev = None
        for n, line in enumerate(open(f, encoding="utf-8").read().split("\n"), 1):
            cells = len(re.findall(r"(?<!\\)\|", line)) if line.startswith("|") else None
            if cells is not None and prev is not None and cells != prev:
                problems.append(f"{f}:{n}: table row has {cells - 1} columns, previous row {prev - 1}")
            prev = cells
    routed = open(skill_md, encoding="utf-8").read()
    for f in files[1:]:
        if os.path.relpath(f, skill_dir) not in routed:
            problems.append(f"{f}: not listed in SKILL.md routing table")
    for root, dirs, _ in os.walk(skill_dir):
        if ".omc" in dirs:
            problems.append(f"stray OMC state: {os.path.join(root, '.omc')}")
    problems += private_scan(files, PRIVATE_IN_SKILLS)
    return problems

def warnings(skill_dir):
    out = []
    for f in sorted(glob.glob(os.path.join(skill_dir, "reference", "*.md"))):
        lines = open(f, encoding="utf-8").read().split("\n")
        top = "\n".join(lines[:20])
        if len(lines) > TOC_MIN_LINES and not re.search(r"^(Contents:|#+ Contents)", top, re.M):
            out.append(f"{f}: {len(lines)} lines and no contents line near the top")
    return out

def repo_files():
    """Top-level markdown and the hand-written mod sources (not the engine-generated types)."""
    out = sorted(glob.glob("*.md"))
    for root, dirs, names in os.walk("mods"):
        dirs[:] = [d for d in dirs if d not in ("types", "node_modules") or not root.endswith(".claude-plugin")]
        out += sorted(os.path.join(root, n) for n in names if n.endswith(MOD_SOURCE_SUFFIXES))
    return out

def report(name, problems):
    print(f"{name}: {'OK' if not problems else f'{len(problems)} problem(s)'}")
    for line in problems:
        print("  -", line)
    return len(problems)

if __name__ == "__main__":
    explicit = sys.argv[1:]
    targets = explicit or sorted(d for d in os.listdir(".") if os.path.isfile(os.path.join(d, "SKILL.md")))
    total = 0
    for t in targets:
        total += report(t, check(t))
        for line in warnings(t):
            print("  warning:", line)
    if not explicit:
        total += report("repo files", private_scan(repo_files(), PRIVATE_ANYWHERE))
    sys.exit(1 if total else 0)
