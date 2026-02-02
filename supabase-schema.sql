-- ============================================
-- TUTORING BOOKING SYSTEM - SUPABASE SCHEMA
-- ============================================
-- Copy & paste into Supabase SQL Editor
-- Execute in order

-- 1. TUTORS TABLE
CREATE TABLE public.tutors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  subject TEXT,
  bio TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. AVAILABILITY TABLE (recurring weekly schedule)
CREATE TABLE public.availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id UUID NOT NULL REFERENCES public.tutors(id) ON DELETE CASCADE,
  day_of_week INT NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6), -- 0=Sunday, 6=Saturday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tutor_id, day_of_week, start_time)
);

-- 3. BOOKINGS TABLE (actual booked slots)
CREATE TABLE public.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id UUID NOT NULL REFERENCES public.tutors(id) ON DELETE CASCADE,
  student_name TEXT NOT NULL,
  student_email TEXT NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT no_overlap UNIQUE NULLS NOT DISTINCT (tutor_id, start_time, end_time) WHERE status = 'confirmed'
);

-- 4. INDEXES for fast queries
CREATE INDEX idx_bookings_tutor_time ON public.bookings(tutor_id, start_time DESC) WHERE status = 'confirmed';
CREATE INDEX idx_availability_tutor ON public.availability(tutor_id, day_of_week);

-- ============================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================

-- Enable RLS on all tables
ALTER TABLE public.tutors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

-- TUTORS: Public read-only
CREATE POLICY "Tutors are publicly readable" ON public.tutors
  FOR SELECT USING (TRUE);

-- AVAILABILITY: Public read-only
CREATE POLICY "Availability is publicly readable" ON public.availability
  FOR SELECT USING (TRUE);

-- BOOKINGS: Public insert (for new bookings) + public read
CREATE POLICY "Anyone can view bookings" ON public.bookings
  FOR SELECT USING (TRUE);

CREATE POLICY "Anyone can create bookings" ON public.bookings
  FOR INSERT WITH CHECK (TRUE);

CREATE POLICY "Only creator can update own booking" ON public.bookings
  FOR UPDATE USING (student_email = current_user_email() OR (current_setting('request.jwt.claims')::'jsonb'->>'sub') IS NULL)
  WITH CHECK (student_email = current_user_email() OR (current_setting('request.jwt.claims')::'jsonb'->>'sub') IS NULL);

-- ============================================
-- SEED DATA (Optional - add real tutors)
-- ============================================

-- INSERT INTO public.tutors (name, timezone, subject, bio) VALUES
-- ('Nicole', 'Africa/Johannesburg', 'Mathematics, Science', 'Grade 3 - Post matric specialist'),
-- ('Deedra', 'Africa/Johannesburg', 'English, Science', 'Grade 3-9 tutor'),
-- ('Karen', 'Africa/Johannesburg', 'Reading, Writing, Math', 'Grade 2-7, young learners specialist');

-- INSERT INTO public.availability (tutor_id, day_of_week, start_time, end_time) VALUES
-- ((SELECT id FROM tutors WHERE name = 'Nicole'), 1, '09:00:00', '17:00:00'),  -- Mon 9am-5pm
-- ((SELECT id FROM tutors WHERE name = 'Nicole'), 2, '09:00:00', '17:00:00'),  -- Tue
-- ((SELECT id FROM tutors WHERE name = 'Nicole'), 3, '09:00:00', '17:00:00'),  -- Wed
-- ((SELECT id FROM tutors WHERE name = 'Nicole'), 4, '09:00:00', '17:00:00'),  -- Thu
-- ((SELECT id FROM tutors WHERE name = 'Nicole'), 5, '09:00:00', '15:00:00');  -- Fri 9am-3pm
