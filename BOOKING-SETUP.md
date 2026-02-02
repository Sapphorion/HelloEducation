# Tutoring Booking System - Setup Guide

## Overview
A production-safe, real-time tutoring booking system built with:
- **Supabase** (PostgreSQL + RLS + Realtime)
- **FullCalendar.js** (Calendar UI)
- **Vanilla JS** (GitHub Pages compatible)

## Prerequisites
- Supabase account (free tier sufficient)
- GitHub account (for Pages hosting)

---

## 1. Supabase Setup

### Step 1: Create Supabase Project
1. Go to https://supabase.com and sign up
2. Create a new project (pick any region)
3. Wait for project to initialize (~3 mins)

### Step 2: Create Database Schema
1. Go to **SQL Editor** in Supabase dashboard
2. Create a new query
3. **Copy entire contents** of `supabase-schema.sql`
4. Paste into the query editor
5. Click **Run**

✓ Tables, RLS policies, and indexes created

### Step 3: Seed Tutors (Optional)
1. In SQL Editor, uncomment the SEED DATA section in `supabase-schema.sql`
2. Replace tutor names/timezones as needed
3. Run the query

### Step 4: Get API Keys
1. Go to **Settings → API**
2. Copy:
   - **Project URL** (your SUPABASE_URL)
   - **anon public key** (your SUPABASE_ANON_KEY)

---

## 2. Frontend Configuration

### Update `booking.js` with your Supabase credentials:

```javascript
// Line 10-11 in booking.js
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

Replace:
- `YOUR_PROJECT_ID` with your project ID from the URL
- `YOUR_ANON_KEY` with your anon key

⚠️ **SECURITY**: These are public keys, safe to expose (RLS protects data)

---

## 3. Add Tutors to Database

### Option A: Supabase Dashboard (Easiest)
1. Go to **Table Editor** → Select `tutors` table
2. Click **+ Insert Row**
3. Fill in:
   - `name`: Tutor name
   - `timezone`: "Africa/Johannesburg" (or timezone for all tutors)
   - `subject`: Subject/grade they teach
   - `bio`: Short bio

### Option B: SQL INSERT
```sql
INSERT INTO public.tutors (name, timezone, subject, bio) VALUES
('Nicole', 'Africa/Johannesburg', 'Mathematics, Science', 'Grade 3 - Post matric'),
('Deedra', 'Africa/Johannesburg', 'English, Science', 'Grade 3-9'),
('Karen', 'Africa/Johannesburg', 'Reading, Writing, Math', 'Grade 2-7');
```

---

## 4. Add Tutor Availability

### Create weekly recurring schedule (same for each week)

```sql
INSERT INTO public.availability (tutor_id, day_of_week, start_time, end_time) VALUES
-- Nicole: Mon-Fri 9am-5pm
((SELECT id FROM tutors WHERE name = 'Nicole'), 1, '09:00:00', '17:00:00'),
((SELECT id FROM tutors WHERE name = 'Nicole'), 2, '09:00:00', '17:00:00'),
((SELECT id FROM tutors WHERE name = 'Nicole'), 3, '09:00:00', '17:00:00'),
((SELECT id FROM tutors WHERE name = 'Nicole'), 4, '09:00:00', '17:00:00'),
((SELECT id FROM tutors WHERE name = 'Nicole'), 5, '09:00:00', '15:00:00'),

-- Deedra: Tue-Thu 10am-4pm, Sat 2pm-6pm
((SELECT id FROM tutors WHERE name = 'Deedra'), 2, '10:00:00', '16:00:00'),
((SELECT id FROM tutors WHERE name = 'Deedra'), 3, '10:00:00', '16:00:00'),
((SELECT id FROM tutors WHERE name = 'Deedra'), 4, '10:00:00', '16:00:00'),
((SELECT id FROM tutors WHERE name = 'Deedra'), 6, '14:00:00', '18:00:00'),

-- Karen: Mon,Wed,Fri 9am-12pm, 2pm-5pm
((SELECT id FROM tutors WHERE name = 'Karen'), 1, '09:00:00', '12:00:00'),
((SELECT id FROM tutors WHERE name = 'Karen'), 1, '14:00:00', '17:00:00'),
((SELECT id FROM tutors WHERE name = 'Karen'), 3, '09:00:00', '12:00:00'),
((SELECT id FROM tutors WHERE name = 'Karen'), 3, '14:00:00', '17:00:00'),
((SELECT id FROM tutors WHERE name = 'Karen'), 5, '09:00:00', '12:00:00'),
((SELECT id FROM tutors WHERE name = 'Karen'), 5, '14:00:00', '17:00:00');
```

**Day of week:** 0=Sunday, 1=Monday, 2=Tuesday, ... 6=Saturday

---

## 5. GitHub Pages Deployment

### Step 1: Push to GitHub
```bash
git add booking.html booking.js supabase-schema.sql
git commit -m "Add tutoring booking system"
git push origin main
```

### Step 2: Enable GitHub Pages
1. Go to repository **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: **main** / folder: **/ (root)**
4. Click **Save**

### Step 3: Access
Your booking page will be live at:
```
https://YOUR_USERNAME.github.io/HelloEducation/booking.html
```

---

## How It Works

### Booking Flow
1. **Student** visits `booking.html`
2. Selects a tutor → Calendar loads with their availability
3. Clicks available 1-hour slots
4. Enters name + email
5. Clicks "Confirm Booking"
6. System inserts all slots or aborts if conflict

### Conflict Prevention
- Database UNIQUE constraint prevents double-booking
- If any slot fails to insert, student gets error
- Real-time listeners auto-update calendar
- Booked slots immediately turn gray

### Real-time Updates
- When student A books a slot
- Student B's calendar updates instantly
- No page refresh needed

---

## Testing

### Manual Test 1: Single Slot Booking
1. Visit booking.html
2. Select a tutor
3. Click one available slot
4. Enter name/email
5. Click "Confirm"
6. ✓ Success message appears

### Manual Test 2: Conflict Prevention
1. Open booking.html in 2 browser tabs
2. In Tab 1: Select same slot, start booking process
3. In Tab 2: Book that same slot first & confirm
4. In Tab 1: Try to confirm
5. ✓ Conflict error appears

### Manual Test 3: Real-time Update
1. Open booking.html in 2 tabs
2. In Tab 1: Book a slot
3. Watch Tab 2 calendar
4. ✓ Slot turns gray instantly (no refresh)

---

## Customization

### Change Timezone
Edit line 13 in `booking.js`:
```javascript
const TIMEZONE = 'America/New_York'; // or any IANA timezone
```

### Change Slot Duration
Edit line 124 in `booking.js`:
```javascript
slotDuration: '00:30:00', // Change to 30 minutes
slotLabelInterval: '00:30',
```

### Styling
Edit CSS in `booking.html` `<style>` block or link to external CSS

---

## Production Checklist

- [ ] Supabase project created
- [ ] Schema + RLS policies applied
- [ ] Tutors added to database
- [ ] Availability schedule created
- [ ] Supabase credentials in booking.js
- [ ] Tested booking in 2 browsers (conflict test)
- [ ] GitHub Pages enabled
- [ ] Booking page accessible via GitHub Pages URL

---

## Support & Debugging

### Calendar Not Loading?
- Check browser console (F12 → Console)
- Verify Supabase URL & key in booking.js
- Check RLS policies allow public SELECT

### Bookings Not Saving?
- Check email validation
- View Supabase **Table Editor → bookings** to see entries
- Verify RLS allows public INSERT

### Real-time Not Working?
- Check Supabase Realtime is enabled (Settings → Realtime)
- Browser must allow WebSocket connections

---

## Database Schema Reference

### tutors
```
id (UUID, PK)
name (TEXT, UNIQUE)
timezone (TEXT)
subject (TEXT)
bio (TEXT)
created_at (TIMESTAMP)
```

### availability
```
id (UUID, PK)
tutor_id (UUID, FK → tutors)
day_of_week (INT: 0-6)
start_time (TIME)
end_time (TIME)
UNIQUE(tutor_id, day_of_week, start_time)
```

### bookings
```
id (UUID, PK)
tutor_id (UUID, FK → tutors)
student_name (TEXT)
student_email (TEXT)
start_time (TIMESTAMP)
end_time (TIMESTAMP)
status (TEXT: 'confirmed'|'cancelled')
created_at (TIMESTAMP)
UNIQUE(tutor_id, start_time, end_time) WHERE status='confirmed'
```

---

**System is production-ready. No paid services used. Free tier sufficient for 100+ tutors and 1000+ bookings/month.**
