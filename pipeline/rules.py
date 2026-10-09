"""The compiled-alert schema and a tiny safe evaluator for its `rule` (no eval).

Rule grammar:
    expr   := or
    or     := and ("||" and)*
    and    := not ("&&" not)*
    not    := "!" not | atom
    atom   := "(" expr ")" | cmp
    cmp    := ref OP value
    ref    := qid | qid "." option          option may be quoted: driver.'reserves running low'
    OP     := >= | > | <= | < | == | !=
    value  := number | 'label' | "label"

Meaning of a ref:
    qid.option          probability the decision model gave that option (0..1)
    qid  (probability)  P(yes)
    qid  (score)        probability-weighted score (0..levels-1)
    qid  (choice)       the most likely option label; compare with == / != 'label'
The web app has a TypeScript twin (web/src/rule.ts); scripts/check_rule_parity.mjs checks they agree.
"""

import re
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from pipeline.luna import Answer, Question

NONE_OPTIONS = ("nothing unusual", "none of these")


class Threshold(BaseModel):
    series: str
    op: Literal[">", ">=", "<", "<="]
    value: float


class Contrast(BaseModel):
    """For "X, not Y" alerts: the choice question and the option labels for X (want) and Y (avoid)."""

    question: str
    want: str
    avoid: str


class CompiledAlert(BaseModel):
    alert_id: str = Field(pattern=r"^[a-z][a-z0-9_]{2,40}$")
    questions: list[Question] = Field(min_length=2, max_length=4)
    primary: str  # id of the probability question that restates the alert
    contrast: Contrast | None = None
    rule: str

    @model_validator(mode="after")
    def check(self):
        ids = [q.id for q in self.questions]
        if len(set(ids)) != len(ids):
            raise ValueError("question ids must be unique")
        for q in self.questions:
            if not re.fullmatch(r"[a-z][a-z0-9_]*", q.id):
                raise ValueError(f"question id {q.id!r} must be snake_case")
            if q.kind == "probability" and q.options != ["yes", "no"]:
                raise ValueError(f"{q.id}: probability questions must have options ['yes', 'no']")
            if q.kind == "choice":
                if not 2 <= len(q.options) <= 6:
                    raise ValueError(f"{q.id}: choice questions need 2-6 options")
                if not any(o.lower() in NONE_OPTIONS for o in q.options):
                    raise ValueError(f"{q.id}: choice questions must include 'nothing unusual' or 'none of these'")
            if q.kind == "score":
                if not 3 <= len(q.options) <= 5:
                    raise ValueError(f"{q.id}: score questions need 3-5 ordered levels")
                for i, o in enumerate(q.options):
                    if not o.startswith(f"{i} "):
                        raise ValueError(f"{q.id}: score levels must be written '0 none', '1 mild', ... in order")
            if len(set(q.options)) != len(q.options):
                raise ValueError(f"{q.id}: duplicate options")
        qs = {q.id: q for q in self.questions}
        tree = parse(self.rule, qs)  # raises on any bad reference
        if self.primary not in qs or qs[self.primary].kind != "probability":
            raise ValueError("primary must be the id of a probability question")
        if not any(c[1] == self.primary for c in leaves(tree)):
            raise ValueError(f"the rule must use the primary question {self.primary!r}")
        if self.contrast:
            c = self.contrast
            if c.question not in qs or qs[c.question].kind != "choice":
                choices = {q.id: q.options for q in self.questions if q.kind == "choice"}
                raise ValueError(
                    f"contrast.question is {c.question!r}, which is not a choice question. "
                    + (f"Your choice questions are {choices}; set contrast.question to the one whose options "
                       f"include the want and avoid options." if choices else
                       "Add a choice question like {\"id\": \"situation\", \"kind\": \"choice\", \"text\": \"Which best "
                       "describes the grid right now?\", \"options\": [\"<want>\", \"<avoid>\", \"nothing unusual\"]}.")
                )
            opts = qs[c.question].options
            if c.want not in opts or c.avoid not in opts or c.want == c.avoid:
                raise ValueError(f"contrast.want and contrast.avoid must be two different options of {c.question}: {opts}")
            if not excludes(tree, c):
                raise ValueError(
                    f"the rule must rule out {c.question} = {c.avoid!r}, e.g. with "
                    f"{c.question} == '{c.want}' or {c.question} != '{c.avoid}' combined by &&"
                )
        return self


# ---------- tokenizer / parser ----------

TOKEN = re.compile(r"""\s*(?:(\|\||&&|>=|<=|==|!=|[><!().])|('(?:[^'])*'|"(?:[^"])*")|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*))""")


def tokenize(src: str) -> list[tuple[str, str]]:
    out, pos = [], 0
    src = src.rstrip()
    while pos < len(src):
        m = TOKEN.match(src, pos)
        if not m or m.end() == pos:
            raise ValueError(f"rule: unexpected text at {src[pos:pos + 20]!r}")
        op, s, num, ident = m.groups()
        out.append(("op", op) if op else ("str", s[1:-1]) if s else ("num", num) if num else ("id", ident))
        pos = m.end()
    return out


def parse(src: str, questions: dict[str, Question]):
    toks = tokenize(src)
    i = 0

    def peek(v=None):
        if i < len(toks) and (v is None or toks[i][1] == v):
            return toks[i]
        return None

    def take(kind=None, v=None):
        nonlocal i
        if i >= len(toks):
            raise ValueError("rule: unexpected end")
        t = toks[i]
        if (kind and t[0] != kind) or (v and t[1] != v):
            raise ValueError(f"rule: expected {v or kind}, got {t[1]!r}")
        i += 1
        return t

    def p_or():
        node = p_and()
        while peek("||"):
            take(v="||")
            node = ("or", node, p_and())
        return node

    def p_and():
        node = p_not()
        while peek("&&"):
            take(v="&&")
            node = ("and", node, p_not())
        return node

    def p_not():
        if peek("!"):
            take(v="!")
            return ("not", p_not())
        if peek("("):
            take(v="(")
            node = p_or()
            take(v=")")
            return node
        return p_cmp()

    def p_cmp():
        qid = take("id")[1]
        if qid not in questions:
            raise ValueError(f"rule: unknown question id {qid!r}")
        q = questions[qid]
        option = None
        if peek("."):
            take(v=".")
            t = take()
            if t[0] not in ("id", "str"):
                raise ValueError("rule: expected option after '.'")
            option = t[1]
            if option not in q.options:
                raise ValueError(f"rule: {qid} has no option {option!r} (options: {q.options})")
        op = take("op")[1]
        if op not in (">=", ">", "<=", "<", "==", "!="):
            raise ValueError(f"rule: expected comparison, got {op!r}")
        kind, val = take()
        if kind == "num":
            if option is None and q.kind == "choice":
                raise ValueError(f"rule: compare choice {qid} to a label, or use {qid}.<option> for its probability")
            return ("cmp", qid, option, op, float(val))
        if kind == "str":
            if option is not None or q.kind != "choice" or op not in ("==", "!="):
                raise ValueError(f"rule: only a choice question can be compared to a label with == or !=")
            if val not in q.options:
                raise ValueError(f"rule: {qid} has no option {val!r}")
            return ("cmp", qid, None, op, val)
        raise ValueError(f"rule: bad value {val!r}")

    tree = p_or()
    if i != len(toks):
        raise ValueError(f"rule: trailing tokens from {toks[i][1]!r}")
    return tree


def leaves(tree):
    if tree[0] in ("or", "and"):
        return leaves(tree[1]) + leaves(tree[2])
    if tree[0] == "not":
        return leaves(tree[1])
    return [tree]


def excludes(tree, c: "Contrast") -> bool:
    """True if every way the rule can be true has the contrast question not at `avoid`:
    a top-level && conjunct that is `q == want`, `q != avoid`, `q.want >= x`, or `q.avoid < x` (x <= 0.5)."""
    if tree[0] == "and":
        return excludes(tree[1], c) or excludes(tree[2], c)
    if tree[0] == "or":
        return excludes(tree[1], c) and excludes(tree[2], c)
    if tree[0] != "cmp" or tree[1] != c.question:
        return False
    _, _, option, op, val = tree
    if option is None:
        return (op == "==" and val == c.want) or (op == "!=" and val == c.avoid)
    if option == c.want:
        return op in (">=", ">") and val >= 0.5
    if option == c.avoid:
        return op in ("<", "<=") and val <= 0.5
    return False


def evaluate(tree, answers: dict[str, Answer]) -> bool:
    kind = tree[0]
    if kind == "or":
        return evaluate(tree[1], answers) or evaluate(tree[2], answers)
    if kind == "and":
        return evaluate(tree[1], answers) and evaluate(tree[2], answers)
    if kind == "not":
        return not evaluate(tree[1], answers)
    _, qid, option, op, val = tree
    a = answers[qid]
    if a.refused:
        return False  # no answer: the comparison can't hold
    if option is not None:
        x = a.probs[option]
    elif a.kind == "probability":
        x = a.probs["yes"]
    elif a.kind == "score":
        x = a.expected
    else:
        x = max(a.probs, key=a.probs.get)
    return {
        ">=": lambda: x >= val, ">": lambda: x > val, "<=": lambda: x <= val, "<": lambda: x < val,
        "==": lambda: x == val, "!=": lambda: x != val,
    }[op]()


def threshold_hit(t: Threshold, value: float | None) -> bool:
    if value is None:
        return False
    return {">": value > t.value, ">=": value >= t.value, "<": value < t.value, "<=": value <= t.value}[t.op]
