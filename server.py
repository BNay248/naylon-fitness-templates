import math
import os
import re
from collections import defaultdict, deque
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import bcrypt
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from pydantic import BaseModel

from db_manager import EQUIPMENT_TYPES, GROUP_FIELDS, LINK_FIELDS, MUSCLE_FIELDS, PATTERN_KINDS, TemplatesDB, unique

# Templates: recipes of slots anyone can write and run (templates.chowmeinframe.com). Shares single sign-on and the
# workout_platform database with the trainer (trainer.) and the nutrition tracker (tracker.).

app = FastAPI()
db = TemplatesDB()
db.ensure_indexes()

ALGORITHM = "HS256"
# COOKIE_DOMAIN (e.g. chowmeinframe.com) scopes the shared login cookie to every subdomain; unset, it stays on the
# current host (local dev).
COOKIE_NAME = "nfp_session"
COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN") or None
TRAINER_URL = os.environ.get("TRAINER_URL", "")
TRACKER_URL = os.environ.get("TRACKER_URL", "")
TOKEN_DAYS = 30
POSSIBLE_METRICS = ["Reps", "Weight", "Duration", "Calories", "Resistance", "Distance"]
MAX_REPEATS = 20
MAX_NOTE = 500

# Signs login cookies (shared with the other apps), so it must be private: required from the environment, never defaulted.
SECRET = os.environ.get("JWT_SECRET", "")
if len(SECRET) < 32:
    raise RuntimeError("Set JWT_SECRET to a random value of at least 32 characters (e.g. `python3 -c \"import secrets; print(secrets.token_hex(32))\"`)")

app.mount("/static", StaticFiles(directory="static"), name="static")

# ==================== SECURITY ====================
# The same protections run in the trainer, templates and tracker apps; keep them in step.

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
SECURITY_HEADERS = {"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin",
                    "Content-Security-Policy": "frame-ancestors 'none'"}
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
LOGIN_WINDOW = 15 * 60
LOGIN_LIMIT_PER_ACCOUNT = 10  # failed logins per window for one username from one address
LOGIN_LIMIT_PER_ADDRESS = 50  # failed logins per window from one address, any username
failed_logins: Dict[tuple, deque] = defaultdict(deque)


def same_origin(request: Request) -> bool:
    """Whether a request came from this site's own pages. The login cookie is shared with every subdomain of the
    cookie domain, so a page on a sibling subdomain counts as same-site and would get the cookie attached."""
    site = request.headers.get("sec-fetch-site")
    if site:
        return site in ("same-origin", "none")
    origin = request.headers.get("origin")
    return not origin or urlparse(origin).netloc == request.headers.get("host")


@app.middleware("http")
async def protect(request: Request, call_next):
    if request.method in UNSAFE_METHODS and request.url.path.startswith("/api/") and not same_origin(request):
        return JSONResponse({"detail": "Cross-site request blocked"}, status_code=403)
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    return response


def client_address(request: Request) -> str:
    # Behind Apache, trust the address it appended to X-Forwarded-For, but only when the request came from the local proxy.
    host = request.client.host if request.client else ""
    forwarded = request.headers.get("x-forwarded-for")
    return forwarded.split(",")[-1].strip() if forwarded and host in ("127.0.0.1", "::1") else host


def login_limits(request: Request, username: str) -> Dict[tuple, int]:
    address = client_address(request)
    return {(address, username.lower()): LOGIN_LIMIT_PER_ACCOUNT, (address,): LOGIN_LIMIT_PER_ADDRESS}


def check_login_allowed(limits: Dict[tuple, int]) -> None:
    now = datetime.now(timezone.utc).timestamp()
    for key, limit in limits.items():
        attempts = failed_logins[key]
        while attempts and now - attempts[0] > LOGIN_WINDOW:
            attempts.popleft()
        if not attempts:
            del failed_logins[key]
        elif len(attempts) >= limit:
            minutes = int((LOGIN_WINDOW - (now - attempts[0])) // 60) + 1
            raise HTTPException(status_code=429, detail=f"Too many failed logins. Try again in {minutes} minute{'s' if minutes != 1 else ''}.")


def record_failed_login(limits: Dict[tuple, int]) -> None:
    now = datetime.now(timezone.utc).timestamp()
    for key in limits:
        failed_logins[key].append(now)


def check_registration(username: str, name: str, email: str) -> None:
    if not USERNAME_PATTERN.match(username):
        raise HTTPException(status_code=400, detail="Usernames are up to 40 letters, numbers, dots, dashes or underscores")
    if len(name) > 80 or len(email) > 120:
        raise HTTPException(status_code=400, detail="Name or email is too long")


def token_revoked(payload: Dict, user: Dict) -> bool:
    """Tokens issued before the user's last password change (tokens_valid_after, epoch seconds) no longer work."""
    return payload.get("iat", 0) < user.get("tokens_valid_after", 0)


@app.middleware("http")
async def revalidate_assets(request: Request, call_next):
    # Without this, browsers guess a cache lifetime for pages/JS/CSS and keep running old code after a deploy.
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response

# ==================== HELPERS ====================


def create_token(username: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"username": username, "iat": int(now.timestamp()), "exp": now + timedelta(days=TOKEN_DAYS)}, SECRET, algorithm=ALGORITHM)


def set_session_cookie(response: Response, username: str) -> None:
    response.set_cookie(COOKIE_NAME, create_token(username), httponly=True, max_age=86400 * TOKEN_DAYS, samesite="lax",
                        domain=COOKIE_DOMAIN, secure=bool(COOKIE_DOMAIN))


def current_user(request: Request) -> Dict:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, SECRET, algorithms=[ALGORITHM])
        username = payload["username"]
    except (JWTError, KeyError):
        raise HTTPException(status_code=401, detail="Invalid session")
    user = db.get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=401, detail="User no longer exists")
    if token_revoked(payload, user):
        raise HTTPException(status_code=401, detail="Please log in again")
    return user


def coach_user(user: Dict = Depends(current_user)) -> Dict:
    if user.get("role") != "coach":
        raise HTTPException(status_code=403, detail="Coaches only")
    return user


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def iso(value: Any) -> Optional[str]:
    # Stored datetimes are naive server-local time; attach the server's offset for the browser.
    return value.astimezone().isoformat() if isinstance(value, datetime) else None


def display_names(usernames: List[str]) -> List[Dict]:
    users = db.get_users_by_usernames(usernames)
    return [{"username": name, "name": users.get(name, {}).get("name", name)} for name in usernames]


def ids_in(collection: str) -> set:
    return {str(item["_id"]) for item in db.get_items(collection)}


def to_int(value: Any) -> int:
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


def to_amount(value: Any) -> float:
    """A metric value: non-negative, up to 2 decimal places, and a plain int when whole (so 10.0 is stored as 10)."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(number) or number <= 0:
        return 0
    number = round(number, 2)
    return int(number) if number.is_integer() else number


def clamp_repeats(value: Any) -> int:
    return min(MAX_REPEATS, max(1, to_int(value) or 1))


def clean_note(value: Any) -> str:
    return str(value or "").strip()[:MAX_NOTE]


def clean_targets(targets: Any, metrics: List[str]) -> Dict[str, int]:
    targets = targets if isinstance(targets, dict) else {}
    return {metric: to_amount(targets[metric]) for metric in metrics if to_amount(targets.get(metric)) > 0}

# ==================== WORKOUTS ====================
# Logged workouts must look exactly like the trainer's (its history, previous values and PRs read them),
# so this mirrors the trainer's clean_snapshot / personal_records. Keep the two in step.


def clean_swap(value: Any) -> Optional[Dict]:
    """The exercise done instead of the planned one for a single round."""
    if not isinstance(value, dict) or not value.get("name"):
        return None
    return {"exercise_id": str(value.get("exercise_id") or ""), "name": str(value["name"]),
            "metrics": [str(metric) for metric in value.get("metrics") or []]}


def clean_instances(instances: Any, metrics: List[str], rounds: int, allow_swaps: bool = False) -> List[Dict]:
    """Exactly `rounds` instances, keeping any provided values for the exercise's metrics (or a swapped round's substitute's)."""
    instances = instances if isinstance(instances, list) else []
    cleaned = []
    for idx in range(rounds):
        raw = instances[idx] if idx < len(instances) and isinstance(instances[idx], dict) else {}
        values = raw.get("metrics") if isinstance(raw.get("metrics"), dict) else {}
        swap = clean_swap(raw.get("swap")) if allow_swaps else None
        instance = {"metrics": {metric: to_amount(values[metric]) for metric in (swap["metrics"] if swap else metrics) if metric in values}}
        if swap:
            instance["swap"] = swap
        cleaned.append(instance)
    return cleaned


def clean_snapshot(raw_supersets: Any) -> List[Dict]:
    """Sanitize a logged workout as the athlete saw it (no catalog lookup, so history stays exact)."""
    supersets = []
    for raw in raw_supersets if isinstance(raw_supersets, list) else []:
        repeats = clamp_repeats(raw.get("repeats"))
        exercises = []
        for raw_exercise in raw.get("exercises") or []:
            metrics = [str(metric) for metric in raw_exercise.get("metrics") or []]
            exercises.append({
                "exercise_id": str(raw_exercise.get("exercise_id") or ""),
                "name": str(raw_exercise.get("name") or ""),
                "metrics": metrics,
                "note": clean_note(raw_exercise.get("note")),
                "targets": clean_targets(raw_exercise.get("targets"), metrics),
                "instances": clean_instances(raw_exercise.get("instances"), metrics, repeats, allow_swaps=True),
            })
        supersets.append({"repeats": repeats, "exercises": exercises})
    return supersets


def clean_structure(raw_supersets: Any, usernames: List[str]) -> List[Dict]:
    """A session's superset/exercise structure (no values), keeping only exercises those users can see."""
    catalog = {str(item["_id"]): item for item in db.get_visible_exercises(usernames)}
    supersets = []
    for raw in raw_supersets if isinstance(raw_supersets, list) else []:
        repeats = clamp_repeats(raw.get("repeats"))
        exercises = []
        for raw_exercise in raw.get("exercises") or []:
            exercise = catalog.get(str(raw_exercise.get("exercise_id") or ""))
            if not exercise:
                continue
            metrics = exercise.get("metrics") or []
            exercises.append({
                "exercise_id": str(exercise["_id"]),
                "name": exercise.get("name", ""),
                "metrics": metrics,
                "note": clean_note(raw_exercise.get("note")),
                "targets": clean_targets(raw_exercise.get("targets"), metrics),
                "instances": clean_instances([], metrics, repeats),
            })
        if exercises:
            supersets.append({"repeats": repeats, "exercises": exercises})
    return supersets


def parse_logged_at(value: Optional[str]) -> datetime:
    now = datetime.now()
    try:
        logged_at = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().replace(tzinfo=None) if value else now
    except ValueError:
        return now
    return min(logged_at, now)


# The first of these an exercise logs decides what counts as a PR for it.
PR_METRICS = ["Weight", "Reps", "Distance", "Duration"]


def rounds_by_exercise(supersets: List[Dict]) -> Dict[str, Dict]:
    """Logged rounds grouped by the exercise actually done (a swapped round counts as its substitute)."""
    found: Dict[str, Dict] = {}
    for superset in supersets:
        for exercise in superset.get("exercises", []):
            for instance in exercise.get("instances", []):
                done = instance.get("swap") or exercise
                if done.get("exercise_id"):
                    entry = found.setdefault(done["exercise_id"], {"name": done.get("name", ""), "rounds": []})
                    entry["rounds"].append(instance.get("metrics") or {})
    return found


def best_round(rounds: List[Dict], metric: str) -> Optional[tuple]:
    """(top value, most reps at that value) across rounds, or None if the metric was never logged."""
    values = [(round_.get(metric) or 0, round_.get("Reps") or 0) for round_ in rounds if (round_.get(metric) or 0) > 0]
    return max(values) if values else None


def personal_records(athlete: str, supersets: List[Dict]) -> List[Dict]:
    """Exercises in a workout (not yet saved) that beat the athlete's previous best. Heavier weight is a PR, as is more
    reps at the same top weight; otherwise more reps, distance or duration. A first log is never a PR. On assisted
    machines more weight means more help, so reps decide."""
    current = rounds_by_exercise(supersets)
    history: Dict[str, List[Dict]] = {}
    for log in db.get_logs_with_exercises(athlete, list(current)):
        for exercise_id, entry in rounds_by_exercise(log.get("supersets", [])).items():
            history.setdefault(exercise_id, []).extend(entry["rounds"])
    records = []
    for exercise_id, entry in current.items():
        past = history.get(exercise_id)
        if not past:
            continue
        for metric in PR_METRICS:
            if metric == "Weight" and "assisted" in entry["name"].lower():
                continue
            now = best_round(entry["rounds"], metric)
            if not now:
                continue
            before = best_round(past, metric)
            if before and now > before:
                records.append({"exercise_id": exercise_id, "name": entry["name"], "metric": metric,
                                "value": now[0], "reps": now[1], "previous": before[0], "previous_reps": before[1]})
            break
    return records

# ==================== PAGES ====================


@app.get("/", include_in_schema=False)
def index():
    return FileResponse("static/index.html")


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse("static/sw.js", media_type="application/javascript")

# ==================== AUTH ====================


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    name: str
    email: str
    password: str


@app.post("/api/login")
def login(req: LoginRequest, request: Request, response: Response):
    limits = login_limits(request, req.username.strip())
    check_login_allowed(limits)
    user = db.get_user_by_username(req.username.strip())
    if not user or not user.get("password") or not bcrypt.checkpw(req.password.encode(), user["password"].encode()):
        record_failed_login(limits)
        raise HTTPException(status_code=401, detail="Username/password is incorrect")
    set_session_cookie(response, user["username"])
    return {"ok": True}


@app.post("/api/register")
def register(req: RegisterRequest, response: Response):
    # Same rules as the trainer's register: one account works in every app.
    username, name, email = req.username.strip(), req.name.strip(), req.email.strip()
    if not username or not name or not email or not req.password:
        raise HTTPException(status_code=400, detail="Please fill all fields")
    check_registration(username, name, email)
    if db.get_user_by_username(username):
        raise HTTPException(status_code=400, detail="Username already exists")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    db.add_user({"username": username, "name": name, "email": email, "password": hash_password(req.password), "role": "client"})
    set_session_cookie(response, username)
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, domain=COOKIE_DOMAIN, secure=bool(COOKIE_DOMAIN), httponly=True, samesite="lax")
    return {"ok": True}


@app.get("/api/me")
def me(user: Dict = Depends(current_user)):
    return {
        "username": user["username"],
        "name": user.get("name", ""),
        "role": user.get("role", "client"),
        "equipment_ids": user.get("equipment_ids") or [],
        "trainer_url": TRAINER_URL,
        "tracker_url": TRACKER_URL,
    }


@app.get("/api/clients")
def list_clients(user: Dict = Depends(current_user)):
    """Who the user can assign templates to: a coach's clients (nobody, for everyone else)."""
    return display_names(user.get("clients") or []) if user.get("role") == "coach" else []

# ==================== EXERCISES & LIBRARY (read-only; managed in the trainer) ====================


def pattern_kind_lookup() -> Dict[str, str]:
    return {str(pattern["_id"]): pattern.get("kind") for pattern in db.get_items("movement_patterns")}


def serialize_exercise(exercise: Dict, kind_of: Dict[str, str]) -> Dict:
    return {
        "id": str(exercise["_id"]),
        "name": exercise.get("name", ""),
        "instructions": exercise.get("instructions", ""),
        "video_url": exercise.get("video_url", ""),
        "metrics": exercise.get("metrics") or [],
        **{field: exercise.get(field) or [] for field in MUSCLE_FIELDS + GROUP_FIELDS + LINK_FIELDS},
        "pattern_kinds": unique(kind_of[i] for i in exercise.get("movement_pattern_ids") or [] if kind_of.get(i)),
    }


@app.get("/api/exercises")
def list_exercises(user: Dict = Depends(current_user)):
    kind_of = pattern_kind_lookup()
    return [serialize_exercise(exercise, kind_of) for exercise in db.get_visible_exercises([user["username"]])]


LIBRARY_COLLECTIONS = ["muscle_groups", "muscles", "equipment", "movement_patterns"]


@app.get("/api/library")
def get_library(user: Dict = Depends(current_user)):
    def serialize_item(item: Dict) -> Dict:
        extra = {key: item.get(key, "") for key in ("group_id", "type", "kind") if key in item}
        return {"id": str(item["_id"]), "name": item.get("name", ""), "description": item.get("description", ""), **extra}
    return {**{collection: [serialize_item(item) for item in db.get_items(collection)] for collection in LIBRARY_COLLECTIONS},
            "equipment_types": EQUIPMENT_TYPES, "pattern_kinds": PATTERN_KINDS}


HISTORY_LOGS = 30  # how far back suggestions look


@app.get("/api/exercise-history")
def exercise_history(user: Dict = Depends(current_user)):
    """Per exercise from the user's recent logs: when it was last done, its latest rounds (previous values), and
    target_streak — how many of its most recent logs hit every target (it drives "ready for the next step")."""
    history: Dict[str, Dict] = {}
    streak_done = set()
    for log in db.get_recent_logs(user["username"], HISTORY_LOGS):
        for exercise_id, entry in rounds_by_exercise(log.get("supersets", [])).items():
            if exercise_id not in history:
                history[exercise_id] = {"last_logged_at": iso(log.get("created_at")), "target_streak": 0,
                                        "previous": {"created_at": iso(log.get("created_at")), "instances": [{"metrics": m} for m in entry["rounds"]]}}
        for superset in log.get("supersets", []):
            for exercise in superset.get("exercises", []):
                exercise_id, targets = exercise.get("exercise_id"), exercise.get("targets") or {}
                if not exercise_id or not targets or exercise_id in streak_done or exercise_id not in history:
                    continue
                rounds = [instance.get("metrics") or {} for instance in exercise.get("instances", []) if not instance.get("swap")]
                hit = bool(rounds) and all((r.get(metric) or 0) >= target for r in rounds for metric, target in targets.items())
                if hit:
                    history[exercise_id]["target_streak"] += 1
                else:
                    streak_done.add(exercise_id)
    return history


@app.get("/api/previous")
def previous_exercise_values(exercise_id: str, user: Dict = Depends(current_user)):
    """The user's most recent logged values for one exercise (prefills a one-off swap)."""
    latest = db.get_latest_exercise_log(user["username"], exercise_id)
    return {"created_at": iso(latest["created_at"]), "instances": latest["instances"]} if latest else None

# ==================== TEMPLATES ====================
# A recipe of slots filled from suggestions. Anyone writes and runs their own; coaches can also assign theirs to
# clients or publish them to all their clients.

SLOT_MODES = ["locked", "shortlist", "open"]
REOPEN_MODES = ["remember", "fresh"]
# Slot rule key -> library collection its ids come from (pattern_kinds hold PATTERN_KINDS names instead).
RULE_COLLECTIONS = {"muscle_group_ids": "muscle_groups", "muscle_ids": "muscles",
                    "movement_pattern_ids": "movement_patterns", "equipment_ids": "equipment"}
NO_EQUIPMENT = "none"  # an equipment rule value: exercises that need no equipment
MAX_SHORTLIST = 30


class TemplateRequest(BaseModel):
    name: str
    description: str = ""
    reopen: str = "remember"
    published: bool = False
    supersets: List[Dict]


class TemplateAssignRequest(BaseModel):
    usernames: List[str]


def matches_rules(rules: Dict, exercise: Dict, kind_of: Dict[str, str]) -> bool:
    """AND across rule keys, OR within one; an empty key doesn't constrain. An equipment rule means "uses some of
    these and nothing else" (so a barbell slot doesn't match bodyweight stretches); NO_EQUIPMENT in it also lets
    through exercises that need no equipment. Mirrored by matchesRules in library-ui.js."""
    def any_of(key: str, values) -> bool:
        return not rules.get(key) or bool(set(rules[key]) & set(values or []))

    def equipment_fits() -> bool:
        allowed, needed = set(rules.get("equipment_ids") or []), set(exercise.get("equipment_ids") or [])
        return not allowed or (needed <= allowed if needed else NO_EQUIPMENT in allowed)
    return (any_of("muscle_group_ids", exercise.get("primary_group_ids"))
            and any_of("muscle_ids", exercise.get("primary_muscle_ids"))
            and any_of("movement_pattern_ids", exercise.get("movement_pattern_ids"))
            and any_of("pattern_kinds", [kind_of.get(i) for i in exercise.get("movement_pattern_ids") or []])
            and equipment_fits())


def clean_slot(raw: Dict, visible: Dict[str, Dict], known: Dict[str, set]) -> Dict:
    label = str(raw.get("label") or "").strip()[:60]
    name = f'Slot "{label}"' if label else "A slot"
    mode = raw.get("mode")
    if mode not in SLOT_MODES:
        raise HTTPException(status_code=400, detail=f"{name}: choose locked, shortlist or open")
    raw_rules = raw.get("rules") if isinstance(raw.get("rules"), dict) else {}
    rules = {key: unique(str(i) for i in raw_rules.get(key) or [] if str(i) in known[key]) for key in RULE_COLLECTIONS}
    if NO_EQUIPMENT in (raw_rules.get("equipment_ids") or []):
        rules["equipment_ids"].append(NO_EQUIPMENT)
    rules["pattern_kinds"] = unique(kind for kind in raw_rules.get("pattern_kinds") or [] if kind in PATTERN_KINDS)
    slot = {"label": label, "mode": mode, "exercise_id": None, "shortlist_ids": [], "rules": rules,
            "note": clean_note(raw.get("note")), "targets": clean_targets(raw.get("targets"), POSSIBLE_METRICS)}
    if mode == "locked":
        if str(raw.get("exercise_id") or "") not in visible:
            raise HTTPException(status_code=400, detail=f"{name}: choose the exercise")
        slot["exercise_id"] = str(raw["exercise_id"])
    elif mode == "shortlist":
        slot["shortlist_ids"] = unique(str(i) for i in raw.get("shortlist_ids") or [] if str(i) in visible)[:MAX_SHORTLIST]
        if not slot["shortlist_ids"]:
            raise HTTPException(status_code=400, detail=f"{name}: add at least one exercise to the shortlist")
    elif not any(rules.values()):
        raise HTTPException(status_code=400, detail=f"{name}: add at least one rule")
    return slot


def clean_template(req: TemplateRequest, user: Dict) -> Dict:
    name = req.name.strip()[:100]
    if not name:
        raise HTTPException(status_code=400, detail="Please enter a template name")
    visible = {str(item["_id"]): item for item in db.get_visible_exercises([user["username"]])}
    known = {key: ids_in(collection) for key, collection in RULE_COLLECTIONS.items()}
    seen, supersets = set(), []
    for raw in req.supersets if isinstance(req.supersets, list) else []:
        slots = []
        for raw_slot in raw.get("slots") or [] if isinstance(raw, dict) else []:
            if not isinstance(raw_slot, dict):
                continue
            slot = clean_slot(raw_slot, visible, known)
            # Stable ids: remembered picks are keyed on them, so edits keep them.
            slot_id = str(raw_slot.get("slot_id") or "")[:16]
            slot["slot_id"] = slot_id if slot_id and slot_id not in seen else uuid.uuid4().hex[:8]
            seen.add(slot["slot_id"])
            slots.append(slot)
        if slots:
            supersets.append({"repeats": clamp_repeats(raw.get("repeats")), "slots": slots})
    if not supersets:
        raise HTTPException(status_code=400, detail="Please add at least one slot")
    return {"name": name, "description": str(req.description or "").strip()[:500],
            "reopen": req.reopen if req.reopen in REOPEN_MODES else "remember",
            # Publishing shares a template with all of a coach's clients, so only coaches can.
            "published": bool(req.published) and user.get("role") == "coach",
            "supersets": supersets}


def serialize_template(template: Dict, user: Dict, names: Dict[str, str]) -> Dict:
    owner = template.get("coach_username")
    return {
        "id": str(template["_id"]),
        "name": template.get("name", ""),
        "description": template.get("description", ""),
        "owner": owner,
        "owner_name": names.get(owner, owner),
        "assignees": template.get("assignees") or [],
        "published": bool(template.get("published")),
        "reopen": template.get("reopen", "remember"),
        "version": template.get("version", 0),
        "supersets": template.get("supersets", []),
        "can_edit": owner == user["username"],
    }


def get_own_template(template_id: str, user: Dict) -> Dict:
    template = db.get_template(template_id)
    if not template or template.get("coach_username") != user["username"]:
        raise HTTPException(status_code=404, detail="Template not found")
    return template


def can_run_template(template: Dict, user: Dict) -> bool:
    return (template.get("coach_username") == user["username"] or user["username"] in (template.get("assignees") or [])
            or (template.get("published") and template.get("coach_username") in (user.get("coaches") or [])))


@app.get("/api/templates")
def list_templates(user: Dict = Depends(current_user)):
    """Templates the user can run, each with their remembered picks when the template re-opens with them."""
    templates = db.get_templates_for_user(user["username"], user.get("coaches") or [])
    picks = db.get_template_picks(user["username"], [str(template["_id"]) for template in templates])
    names = {item["username"]: item["name"] for item in display_names(list({t.get("coach_username") for t in templates}))}
    return [{**serialize_template(template, user, names),
             "remembered_picks": picks.get(str(template["_id"]), {}) if template.get("reopen") == "remember" else {}}
            for template in templates]


@app.post("/api/templates")
def create_template(req: TemplateRequest, user: Dict = Depends(current_user)):
    template = {**clean_template(req, user), "coach_username": user["username"], "assignees": [], "version": 0}
    return {"id": db.add_template(template)}


@app.put("/api/templates/{template_id}")
def update_template(template_id: str, req: TemplateRequest, user: Dict = Depends(current_user)):
    """Sessions saved from a template are separate copies, so editing it never changes them."""
    get_own_template(template_id, user)
    db.update_template(template_id, clean_template(req, user))
    return {"ok": True}


@app.delete("/api/templates/{template_id}")
def delete_template(template_id: str, user: Dict = Depends(current_user)):
    get_own_template(template_id, user)
    db.delete_template(template_id)
    return {"ok": True}


@app.post("/api/templates/{template_id}/assign")
def assign_template(template_id: str, req: TemplateAssignRequest, user: Dict = Depends(coach_user)):
    """Sets exactly who the template is assigned to (only the coach's clients)."""
    get_own_template(template_id, user)
    clients = set(user.get("clients") or [])
    if any(name not in clients for name in req.usernames):
        raise HTTPException(status_code=400, detail="You can only assign templates to your clients")
    db.update_template(template_id, {"assignees": unique(req.usernames)})
    return {"ok": True}


class TemplateLogRequest(BaseModel):
    supersets: List[Dict]
    picks: Dict[str, str] = {}
    client_id: Optional[str] = None
    logged_at: Optional[str] = None


def valid_picks(template: Dict, picks: Dict[str, str], athlete: str) -> Dict[str, str]:
    """The picks that still fit their slot (the template may have changed while the user trained)."""
    visible = {str(item["_id"]): item for item in db.get_visible_exercises([athlete, template.get("coach_username")])}
    kind_of = pattern_kind_lookup()
    valid = {}
    for superset in template.get("supersets", []):
        for slot in superset.get("slots", []):
            pick = picks.get(slot["slot_id"])
            if pick not in visible:
                continue
            if (slot["mode"] == "locked" and pick == slot.get("exercise_id")
                    or slot["mode"] == "shortlist" and pick in slot.get("shortlist_ids", [])
                    or slot["mode"] == "open" and matches_rules(slot.get("rules", {}), visible[pick], kind_of)):
                valid[slot["slot_id"]] = pick
    return valid


@app.post("/api/templates/{template_id}/log")
def log_template_workout(template_id: str, req: TemplateLogRequest, user: Dict = Depends(current_user)):
    """Record a workout built from a template. It's never lost: it's recorded even if the template changed or was
    deleted meanwhile (e.g. while offline); only picks that still fit their slot are remembered."""
    snapshot = clean_snapshot(req.supersets)
    if not any(superset["exercises"] for superset in snapshot):
        raise HTTPException(status_code=400, detail="Nothing to log")
    athlete = user["username"]
    template = db.get_template(template_id)
    if template and not can_run_template(template, user):
        raise HTTPException(status_code=404, detail="Template not found")
    prs = personal_records(athlete, snapshot)  # before saving, so this workout isn't compared with itself
    name = (template or {}).get("name") or "Deleted template"
    extra = {"template_id": template_id, "template_version": (template or {}).get("version")}
    log_id = db.add_workout_log({"_id": template_id, "name": name, "user_id": athlete}, snapshot, athlete,
                                req.client_id, parse_logged_at(req.logged_at), extra)
    if template and template.get("reopen") == "remember":
        picks = valid_picks(template, req.picks, athlete)
        if picks:
            db.save_template_picks(template_id, athlete, picks)
    return {"id": log_id, "prs": prs, "template_deleted": template is None}


class SaveAsSessionRequest(BaseModel):
    name: str
    supersets: List[Dict]
    client_id: Optional[str] = None


@app.post("/api/templates/{template_id}/save-as-session")
def save_as_session(template_id: str, req: SaveAsSessionRequest, user: Dict = Depends(current_user)):
    """Keeps a run's picks as a normal trainer session of the user's own, independent of the template from then on."""
    if req.client_id:
        existing = db.get_session_by_client_id(req.client_id)
        if existing:
            return {"id": str(existing["_id"])}
    name = req.name.strip()[:100]
    supersets = clean_structure(req.supersets, [user["username"]])
    if not name or not supersets:
        raise HTTPException(status_code=400, detail="Nothing to save")
    # Same shape as a session created in the trainer.
    return {"id": db.add_session({"name": name, "supersets": supersets, "user_id": user["username"], "coach_username": user["username"],
                                  "version": 0, "updated_by": user["username"], "client_id": req.client_id,
                                  "from_template_id": template_id})}
