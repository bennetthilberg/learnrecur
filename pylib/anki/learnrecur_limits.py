# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Format ceilings and companion quotas; saved data ignores lowered quotas."""

from dataclasses import asdict, dataclass

# Readers use these bounds on every host. Quotas only restrict new writes.
MAX_BYTES = 64 * 1024 * 1024
MAX_SKILLS = 5000
MAX_EXERCISES = 256  # The usage bitmap must fit native card custom data.
MAX_BATCHES = 5000


@dataclass(frozen=True)
class StorageLimits:
    max_snapshot_bytes: int = 8 * 1024 * 1024
    max_skills: int = 500
    max_exercises: int = 200
    max_jobs: int = 1000
    max_batches: int = 1000

    def __post_init__(self):
        ceilings = {
            "max_snapshot_bytes": MAX_BYTES,
            "max_skills": MAX_SKILLS,
            "max_exercises": MAX_EXERCISES,
            "max_jobs": 10000,
            "max_batches": MAX_BATCHES,
        }
        for name, ceiling in ceilings.items():
            value = getattr(self, name)
            if type(value) is not int or not 1 <= value <= ceiling:
                raise ValueError(f"Set {name} between 1 and {ceiling}.")

    def updated(self, changes):
        if not isinstance(changes, dict) or set(changes) - asdict(self).keys():
            raise ValueError("Unknown storage limit.")
        return StorageLimits(**(asdict(self) | changes))
