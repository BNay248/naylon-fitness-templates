from datetime import datetime
from typing import Dict, List, Optional

from bson.objectid import ObjectId
from pymongo import ASCENDING, MongoClient

# Shares the trainer's database (workout_platform): users, exercises and the library are read here, templates are
# owned here, and template workouts are written to workout_logs in the trainer's format so its history and PRs see them.

# Exercise fields served to the browser (same names as the trainer's exercise documents).
MUSCLE_FIELDS = ["primary_muscle_ids", "secondary_muscle_ids"]
GROUP_FIELDS = ["primary_group_ids", "secondary_group_ids"]
LINK_FIELDS = ["equipment_ids", "movement_pattern_ids", "progression_ids"]
EQUIPMENT_TYPES = ["Free Weight", "Machine", "Cable", "Bodyweight", "Accessory", "Cardio"]
PATTERN_KINDS = ["Compound", "Isolation", "Core", "Power", "Skill", "Mobility", "Conditioning"]


def to_object_id(value: str) -> Optional[ObjectId]:
    try:
        return ObjectId(value)
    except Exception:
        return None


def unique(values) -> List[str]:
    return list(dict.fromkeys(values))


class TemplatesDB:
    def __init__(self, connection_string="mongodb://localhost:27017/"):
        self.client = MongoClient(connection_string)
        self.db = self.client.workout_platform

    def ensure_indexes(self) -> None:
        self.db.templates.create_index("coach_username")
        self.db.templates.create_index("assignees", sparse=True)
        self.db.template_picks.create_index([("template_id", ASCENDING), ("username", ASCENDING)], unique=True)

    # Users
    def add_user(self, user_data: Dict) -> str:
        return str(self.db.users.insert_one(user_data).inserted_id)

    def get_user_by_username(self, username: str) -> Optional[Dict]:
        return self.db.users.find_one({"username": username})

    def get_users_by_usernames(self, usernames: List[str]) -> Dict[str, Dict]:
        return {user["username"]: user for user in self.db.users.find({"username": {"$in": list(usernames)}})}

    # Exercises and library (read-only here; managed in the trainer)
    def get_visible_exercises(self, usernames: List[str]) -> List[Dict]:
        """Global exercises (no owner) plus the personal exercises of the given users."""
        found = self.db.exercises.find({"owner": {"$in": [None, *usernames]}})
        return sorted(found, key=lambda item: str(item.get("name", "")).lower())

    def get_items(self, collection: str) -> List[Dict]:
        return sorted(self.db[collection].find(), key=lambda item: str(item.get("name", "")).lower())

    # Templates. coach_username is the owner (the field predates templates being open to everyone).
    def add_template(self, template_data: Dict) -> str:
        template_data["created_at"] = template_data["updated_at"] = datetime.now()
        return str(self.db.templates.insert_one(template_data).inserted_id)

    def get_template(self, template_id: str) -> Optional[Dict]:
        oid = to_object_id(template_id)
        return self.db.templates.find_one({"_id": oid}) if oid else None

    def get_templates_for_user(self, username: str, coaches: List[str]) -> List[Dict]:
        """Templates a user owns, is assigned, or that one of their coaches published."""
        found = self.db.templates.find({"$or": [{"coach_username": username}, {"assignees": username},
                                                {"published": True, "coach_username": {"$in": list(coaches)}}]})
        return sorted(found, key=lambda item: str(item.get("name", "")).lower())

    def update_template(self, template_id: str, updates: Dict) -> bool:
        oid = to_object_id(template_id)
        updates["updated_at"] = datetime.now()
        return bool(oid) and self.db.templates.update_one({"_id": oid}, {"$set": updates, "$inc": {"version": 1}}).matched_count > 0

    def delete_template(self, template_id: str) -> bool:
        oid = to_object_id(template_id)
        self.db.template_picks.delete_many({"template_id": template_id})
        return bool(oid) and self.db.templates.delete_one({"_id": oid}).deleted_count > 0

    def get_template_picks(self, username: str, template_ids: List[str]) -> Dict[str, Dict[str, str]]:
        found = self.db.template_picks.find({"username": username, "template_id": {"$in": list(template_ids)}})
        return {item["template_id"]: item.get("picks") or {} for item in found}

    def save_template_picks(self, template_id: str, username: str, picks: Dict[str, str]) -> None:
        self.db.template_picks.update_one({"template_id": template_id, "username": username},
                                          {"$set": {"picks": picks, "updated_at": datetime.now()}}, upsert=True)

    # Sessions ("Save as my session" creates a normal trainer session)
    def add_session(self, session_data: Dict) -> str:
        session_data["created_at"] = datetime.now()
        return str(self.db.sessions.insert_one(session_data).inserted_id)

    def get_session_by_client_id(self, client_id: str) -> Optional[Dict]:
        return self.db.sessions.find_one({"client_id": client_id})

    # Workout logs
    def add_workout_log(self, session: Dict, supersets: List[Dict], logged_by: str,
                        client_id: Optional[str] = None, created_at: Optional[datetime] = None, extra: Optional[Dict] = None) -> str:
        if client_id:
            existing = self.db.workout_logs.find_one({"client_id": client_id})
            if existing:
                return str(existing["_id"])
        result = self.db.workout_logs.insert_one({
            "session_id": str(session.get("_id")),
            "session_name": session.get("name", ""),
            "user_id": session.get("user_id"),
            "logged_by": logged_by,
            "created_at": created_at or datetime.now(),
            "supersets": supersets,
            "client_id": client_id,
            **(extra or {}),
        })
        return str(result.inserted_id)

    def get_recent_logs(self, user_id: str, limit: int) -> List[Dict]:
        return list(self.db.workout_logs.find({"user_id": user_id}, {"supersets": 1, "created_at": 1}).sort("created_at", -1).limit(limit))

    def get_logs_with_exercises(self, user_id: str, exercise_ids: List[str]) -> List[Dict]:
        """A user's logs that include any of these exercises, planned or swapped in."""
        return list(self.db.workout_logs.find(
            {"user_id": user_id, "$or": [{"supersets.exercises.exercise_id": {"$in": exercise_ids}},
                                         {"supersets.exercises.instances.swap.exercise_id": {"$in": exercise_ids}}]},
            {"supersets": 1},
        ))

    def get_latest_exercise_log(self, user_id: str, exercise_id: str) -> Optional[Dict]:
        """Most recent logged rounds of an exercise for a user: {"created_at", "instances"}. Rounds swapped for another
        exercise count as that exercise, so a log where every round was swapped out is skipped."""
        logs = self.db.workout_logs.find(
            {"user_id": user_id, "$or": [{"supersets.exercises.exercise_id": exercise_id},
                                          {"supersets.exercises.instances.swap.exercise_id": exercise_id}]},
            sort=[("created_at", -1)],
        )
        for log in logs:
            for superset in log.get("supersets", []):
                for exercise in superset.get("exercises", []):
                    rounds = [{"metrics": instance.get("metrics", {})} for instance in exercise.get("instances", [])
                              if ((instance.get("swap") or {}).get("exercise_id") or exercise.get("exercise_id")) == exercise_id]
                    if rounds:
                        return {"created_at": log.get("created_at"), "instances": rounds}
        return None
