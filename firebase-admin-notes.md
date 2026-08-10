# Admin-controlled tutor and student setup

## Firestore collections to create
- users
- tutors
- students
- sessions
- dashboardData
- tutorDashboardData
- bookings

## Recommended document shapes
### users/{uid}
```json
{
  "role": "admin" | "tutor" | "student" | "parent",
  "email": "user@example.com",
  "name": "Display Name",
  "childUids": ["studentUid1", "studentUid2"]
}
```
`childUids` only applies to `role: "parent"` accounts, and is what links a parent to their child's student account. It can only be set by an admin (see the "Grant a role" tool's linked-children editor, or the "Create an account" form when creating a parent).

### sessions/{sessionId}
```json
{
  "studentId": "student-uid",
  "studentEmail": "maya@helloeducation.com",
  "tutorId": "tutor-uid",
  "subject": "Maths",
  "scheduledAt": "Firestore Timestamp",
  "status": "scheduled" | "completed" | "cancelled",
  "notes": "Covered quadratic equations, going well.",
  "createdAt": "Firestore Timestamp"
}
```
Tutors log these from their dashboard ("Log a session"). This single collection drives the student dashboard's upcoming sessions + progress/feedback, and the parent dashboard's per-child view of the same.

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
