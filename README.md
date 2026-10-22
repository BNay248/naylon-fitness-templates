# Naylon Fitness Templates

Workout templates: recipes of slots that are filled from ranked suggestions each time you train.

Part of the **Naylon Fitness Portal**, three apps that share one login and one MongoDB database (`workout_platform`):

- [naylon-fitness-trainer](https://github.com/BNay248/naylon-fitness-trainer): sessions, workout logging, exercise library, coaching, muscle coverage
- [naylon-fitness-templates](https://github.com/BNay248/naylon-fitness-templates): slot-based workout templates with ranked suggestions
- [naylon-fitness-tracker](https://github.com/BNay248/naylon-fitness-tracker): calorie and protein tracking

## Features

- Slots are locked (one exercise), a shortlist, or open: any exercise matching rules (muscle groups, muscles, movement patterns, equipment, exercise kind, or no equipment)
- Suggestions ranked by fit, the user's equipment, recent history and ready-for-next-step progressions, without repeats across slots
- Runs are logged exactly like trainer sessions (history, previous values, PRs) and can be saved as a normal session
- Anyone can write templates; coaches can also assign them to clients or publish them to all their clients

## Running it

Needs Python 3.10+ and MongoDB on `localhost:27017`.

```bash
python -m venv venv && venv/bin/pip install -r requirements.txt
JWT_SECRET=$(python -c "import secrets; print(secrets.token_hex(32))") venv/bin/uvicorn server:app --port 8503
```

### Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | **Required.** At least 32 random characters; signs the shared login cookie. Use the same value in all three apps. |
| `COOKIE_DOMAIN` | Parent domain for single sign-on (e.g. `example.com`). Leave unset for local development. |
| `TRAINER_URL`, `TRACKER_URL` | Links to the other apps in the navigation. |

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md): free for personal and other non-commercial use. Commercial use, including selling it or running it as a paid service, needs the author's permission.

Required Notice: Copyright (c) 2026 Bradley Naylon (https://github.com/BNay248)
