// ============================================
// TUTORING BOOKING SYSTEM - FRONTEND
// ============================================
// Supabase client configuration & booking logic
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.38.0/+esm';

// ============ CONFIGURATION ============
// TODO: Replace with your Supabase credentials
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
const TIMEZONE = 'Africa/Johannesburg'; // Same for all tutors

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============ STATE ============
let selectedTutor = null;
let selectedSlots = [];
let calendarInstance = null;
let bookingsRealtimeChannel = null;

// ============ INITIALIZATION ============
document.addEventListener('DOMContentLoaded', async () => {
  await loadTutors();
  
  // Auto-select tutor from URL parameter
  const urlParams = new URLSearchParams(window.location.search);
  const tutorName = urlParams.get('tutor');
  
  if (tutorName) {
    // Wait a moment for tutors to load, then select the tutor
    setTimeout(() => {
      const tutorItems = document.querySelectorAll('.tutor-item');
      tutorItems.forEach(item => {
        if (item.querySelector('.tutor-name').textContent === tutorName) {
          item.click();
        }
      });
    }, 500);
  }
  
  setupRealtimeListener();
});

// ============ LOAD TUTORS ============
async function loadTutors() {
  try {
    const { data: tutors, error } = await supabase
      .from('tutors')
      .select('*')
      .order('name');
    
    if (error) throw error;
    
    const tutorsList = document.getElementById('tutorsList');
    tutorsList.innerHTML = '';
    
    tutors.forEach(tutor => {
      const div = document.createElement('div');
      div.className = 'tutor-item';
      div.innerHTML = `
        <div class="tutor-name">${tutor.name}</div>
        <div class="tutor-subject">${tutor.subject || 'Tutor'}</div>
      `;
      div.onclick = () => selectTutor(tutor);
      tutorsList.appendChild(div);
    });
  } catch (err) {
    console.error('Error loading tutors:', err.message);
    showFeedback('Failed to load tutors', 'error');
  }
}

// ============ SELECT TUTOR & LOAD CALENDAR ============
async function selectTutor(tutor) {
  selectedTutor = tutor;
  selectedSlots = [];
  
  // Update UI
  document.querySelectorAll('.tutor-item').forEach(el => el.classList.remove('active'));
  event.target.closest('.tutor-item').classList.add('active');
  
  document.getElementById('selectedTutorName').textContent = `${tutor.name}'s Availability`;
  document.getElementById('selectedTutorSubject').textContent = tutor.subject || 'Tutor';
  document.getElementById('bookingForm').classList.add('active');
  document.getElementById('calendar').style.display = 'block';
  document.getElementById('selectedSlotsList').innerHTML = '';
  document.getElementById('slotCount').textContent = '0';
  
  // Initialize calendar for this tutor
  initializeCalendar();
}

// ============ INITIALIZE FULLCALENDAR ============
async function initializeCalendar() {
  const calendarEl = document.getElementById('calendar');
  
  // Destroy existing calendar
  if (calendarInstance) {
    calendarInstance.destroy();
  }
  
  // Fetch availability and bookings
  const { data: availability, error: availError } = await supabase
    .from('availability')
    .select('*')
    .eq('tutor_id', selectedTutor.id);
  
  const { data: bookings, error: bookError } = await supabase
    .from('bookings')
    .select('*')
    .eq('tutor_id', selectedTutor.id)
    .eq('status', 'confirmed');
  
  if (availError || bookError) {
    showFeedback('Error loading calendar data', 'error');
    return;
  }
  
  // Build disabled times (booked slots)
  const disabledTimes = new Set();
  bookings.forEach(booking => {
    disabledTimes.add(new Date(booking.start_time).toISOString());
  });
  
  // Create events for available slots (1-hour each)
  const events = [];
  const now = new Date();
  
  // Generate next 6 weeks of slots
  for (let d = 0; d < 42; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    const dayOfWeek = date.getDay();
    
    // Find availability for this day
    const dayAvail = availability.find(a => a.day_of_week === dayOfWeek);
    if (!dayAvail) continue;
    
    // Skip past dates
    if (date < now) continue;
    
    // Generate 1-hour slots within availability window
    const [startHour, startMin] = dayAvail.start_time.split(':').map(Number);
    const [endHour, endMin] = dayAvail.end_time.split(':').map(Number);
    
    let slotStart = new Date(date);
    slotStart.setHours(startHour, startMin, 0, 0);
    
    const slotEnd = new Date(date);
    slotEnd.setHours(endHour, endMin, 0, 0);
    
    while (slotStart < slotEnd) {
      const slotEndTime = new Date(slotStart);
      slotEndTime.setHours(slotEndTime.getHours() + 1);
      
      const slotKey = slotStart.toISOString();
      const isBooked = disabledTimes.has(slotKey);
      
      events.push({
        id: slotKey,
        title: isBooked ? 'Booked' : 'Available',
        start: slotStart,
        end: slotEndTime,
        backgroundColor: isBooked ? '#ccc' : '#43a547',
        borderColor: isBooked ? '#999' : '#2e7d2e',
        textColor: isBooked ? '#666' : 'white',
        extendedProps: {
          isBooked: isBooked,
          startTime: slotStart.toISOString(),
          endTime: slotEndTime.toISOString()
        }
      });
      
      slotStart = slotEndTime;
    }
  }
  
  // Initialize FullCalendar
  calendarInstance = new FullCalendar.Calendar(calendarEl, {
    initialView: 'timeGridWeek',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'timeGridWeek,timeGridDay'
    },
    plugins: ['timeGrid', 'interaction'],
    events: events,
    slotDuration: '01:00:00',
    slotLabelInterval: '01:00',
    slotLabelFormat: {
      meridiem: 'short',
      hour: 'numeric',
      minute: '2-digit'
    },
    height: 'auto',
    eventClick: (info) => handleSlotClick(info),
    datesSet: (info) => {
      // Refresh events when calendar view changes
      refreshCalendarEvents(info);
    }
  });
  
  calendarInstance.render();
}

// ============ HANDLE SLOT CLICK ============
function handleSlotClick(info) {
  const { isBooked, startTime, endTime } = info.event.extendedProps;
  
  if (isBooked) {
    showFeedback('This slot is already booked', 'error');
    return;
  }
  
  // Toggle selection
  const slotIndex = selectedSlots.findIndex(s => s.startTime === startTime);
  
  if (slotIndex > -1) {
    selectedSlots.splice(slotIndex, 1);
    info.event.backgroundColor = '#43a547';
    info.event.borderColor = '#2e7d2e';
  } else {
    selectedSlots.push({
      startTime: startTime,
      endTime: endTime
    });
    info.event.backgroundColor = '#2e7d2e';
    info.event.borderColor = '#1a4d1a';
  }
  
  calendarInstance.refetchEvents();
  updateSelectedSlotsList();
}

// ============ UPDATE SELECTED SLOTS DISPLAY ============
function updateSelectedSlotsList() {
  const list = document.getElementById('selectedSlotsList');
  const count = document.getElementById('slotCount');
  
  list.innerHTML = '';
  count.textContent = selectedSlots.length;
  
  selectedSlots.forEach((slot, index) => {
    const date = new Date(slot.startTime);
    const timeStr = date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      meridiem: 'short'
    });
    
    const badge = document.createElement('div');
    badge.className = 'slot-badge';
    badge.innerHTML = `
      ${timeStr}
      <span class="remove" onclick="removeSlot(${index})">×</span>
    `;
    list.appendChild(badge);
  });
}

// ============ REMOVE SLOT ============
function removeSlot(index) {
  selectedSlots.splice(index, 1);
  updateSelectedSlotsList();
  calendarInstance.refetchEvents();
}

// ============ CLEAR SELECTION ============
function clearSelection() {
  selectedSlots = [];
  updateSelectedSlotsList();
  document.getElementById('bookingForm').classList.remove('active');
  document.getElementById('calendar').style.display = 'none';
}

// ============ SUBMIT BOOKING ============
document.getElementById('bookingForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  if (selectedSlots.length === 0) {
    showFeedback('Please select at least one session', 'error');
    return;
  }
  
  const studentName = document.getElementById('studentName').value.trim();
  const studentEmail = document.getElementById('studentEmail').value.trim();
  
  if (!studentName || !studentEmail) {
    showFeedback('Please fill in all required fields', 'error');
    return;
  }
  
  try {
    // Sort slots by start time
    const sortedSlots = [...selectedSlots].sort((a, b) => 
      new Date(a.startTime) - new Date(b.startTime)
    );
    
    // Insert bookings sequentially
    const bookingIds = [];
    
    for (const slot of sortedSlots) {
      const { data, error } = await supabase
        .from('bookings')
        .insert({
          tutor_id: selectedTutor.id,
          student_name: studentName,
          student_email: studentEmail,
          start_time: slot.startTime,
          end_time: slot.endTime,
          status: 'confirmed'
        })
        .select();
      
      if (error) {
        // Conflict detected - rollback
        if (error.code === '23505') { // UNIQUE violation
          throw new Error('One or more slots were just booked. Please refresh and try again.');
        }
        throw error;
      }
      
      bookingIds.push(data[0].id);
    }
    
    showFeedback(
      `✓ Booking confirmed! ${selectedSlots.length} session(s) booked. Confirmation sent to ${studentEmail}`,
      'success'
    );
    
    // Clear form
    setTimeout(() => {
      document.getElementById('studentName').value = '';
      document.getElementById('studentEmail').value = '';
      selectedSlots = [];
      updateSelectedSlotsList();
      initializeCalendar();
    }, 2000);
    
  } catch (err) {
    console.error('Booking error:', err.message);
    showFeedback(`Booking failed: ${err.message}`, 'error');
  }
});

// ============ REALTIME UPDATES ============
function setupRealtimeListener() {
  // Subscribe to bookings table changes
  bookingsRealtimeChannel = supabase
    .channel('public:bookings')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'bookings',
        filter: selectedTutor ? `tutor_id=eq.${selectedTutor.id}` : undefined
      },
      (payload) => {
        console.log('New booking:', payload.new);
        // Refresh calendar when new booking is inserted
        if (selectedTutor && payload.new.tutor_id === selectedTutor.id) {
          if (calendarInstance) {
            calendarInstance.refetchEvents();
          }
        }
      }
    )
    .subscribe();
}

// ============ UTILITIES ============
function showFeedback(message, type) {
  const feedback = document.getElementById('feedback');
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
  
  if (type === 'success') {
    setTimeout(() => {
      feedback.className = 'feedback';
    }, 4000);
  }
}

async function refreshCalendarEvents(dateInfo) {
  if (!selectedTutor || !calendarInstance) return;
  
  // Refetch bookings for current month view
  const { data: bookings } = await supabase
    .from('bookings')
    .select('*')
    .eq('tutor_id', selectedTutor.id)
    .eq('status', 'confirmed')
    .gte('start_time', dateInfo.start.toISOString())
    .lt('start_time', dateInfo.end.toISOString());
  
  // Update event colors in calendar
  const disabledTimes = new Set();
  bookings.forEach(b => {
    disabledTimes.add(new Date(b.start_time).toISOString());
  });
  
  calendarInstance.getEvents().forEach(event => {
    const isNowBooked = disabledTimes.has(event.extendedProps.startTime);
    if (isNowBooked && event.backgroundColor === '#43a547') {
      event.setProp('backgroundColor', '#ccc');
      event.setProp('borderColor', '#999');
      event.setProp('title', 'Booked');
    }
  });
}
