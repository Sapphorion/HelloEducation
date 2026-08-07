# Admin-controlled tutor and student setup

## Firestore collections to create
- users
- tutors
- students
- dashboardData
- tutorDashboardData
- bookings

## Recommended document shapes
### users/{uid}
```json
{
  "role": "admin" | "tutor" | "student",
  "email": "user@example.com",
  "name": "Display Name"
}
```

### tutors/{tutorId}
```json
{
  "name": "Aisha Khan",
  "email": "aisha@helloeducation.com",
  "subject": "Maths",
  "bio": "Tutor bio",
  "status": "active",
  "createdBy": "admin-user-id"
}
```

### students/{studentId}
```json
{
  "name": "Maya Brooks",
  "email": "maya@helloeducation.com",
  "grade": "GCSE",
  "status": "active",
  "createdBy": "admin-user-id"
}
```

## Admin role note
Only the main admin account should be able to create, edit, or delete tutor profiles. Students cannot freely modify tutors or other protected records.

Roles cannot be self-assigned beyond `student` (enforced in `firestore.rules`). To make someone a tutor or admin, sign in as the admin, open `admin-dashboard.html`, and use the "Grant a role" tool to look up their account by email and set their role. See `FIREBASE-SETUP.md` for bootstrapping the very first admin account.
