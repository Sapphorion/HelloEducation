-- ============================================
-- CONFLICT PREVENTION TESTING SCRIPT
-- ============================================
-- Run these queries to verify system prevents double-booking

-- 1. Test UNIQUE constraint (should succeed)
INSERT INTO public.bookings (tutor_id, student_name, student_email, start_time, end_time)
SELECT 
  id,
  'Test Student 1',
  'test1@example.com',
  NOW() + INTERVAL '2 days' + INTERVAL '10 hours',
  NOW() + INTERVAL '2 days' + INTERVAL '11 hours'
FROM tutors
WHERE name = 'Nicole'
LIMIT 1;

-- 2. Try to insert overlapping slot for same tutor (should FAIL with 23505 error)
INSERT INTO public.bookings (tutor_id, student_name, student_email, start_time, end_time)
SELECT 
  id,
  'Test Student 2',
  'test2@example.com',
  NOW() + INTERVAL '2 days' + INTERVAL '10 hours',
  NOW() + INTERVAL '2 days' + INTERVAL '11 hours'
FROM tutors
WHERE name = 'Nicole'
LIMIT 1;
-- Expected error: duplicate key value violates unique constraint

-- 3. Verify booking was created
SELECT * FROM public.bookings 
WHERE student_name LIKE 'Test Student%'
ORDER BY created_at DESC;

-- 4. Clean up test data
DELETE FROM public.bookings 
WHERE student_name LIKE 'Test Student%';

-- ============================================
-- PERFORMANCE QUERY TESTS
-- ============================================

-- Get all available slots for tutor this week (should be fast with index)
EXPLAIN ANALYZE
SELECT 
  t.id,
  t.name,
  a.day_of_week,
  a.start_time,
  a.end_time
FROM public.tutors t
JOIN public.availability a ON t.id = a.tutor_id
WHERE t.id = 'TUTOR_UUID_HERE'
ORDER BY a.day_of_week, a.start_time;

-- Get booked slots for a tutor (uses index)
EXPLAIN ANALYZE
SELECT 
  start_time,
  end_time,
  student_name
FROM public.bookings
WHERE tutor_id = 'TUTOR_UUID_HERE'
  AND status = 'confirmed'
  AND start_time > NOW()
ORDER BY start_time DESC
LIMIT 100;
