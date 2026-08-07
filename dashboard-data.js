import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import { getFirestore, collection, getDocs, setDoc, doc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js';

const demoData = {
  student: {
    summary: 'You have two upcoming sessions and three new study resources.',
    tasks: [
      { title: 'Complete algebra worksheet', done: false },
      { title: 'Review essay feedback', done: true }
    ],
    upcomingSessions: [
      { title: 'Algebra revision', time: 'Today • 4:00 PM' },
      { title: 'Essay planning', time: 'Tomorrow • 10:30 AM' }
    ],
    resources: [
      { title: 'GCSE Maths formula sheet', type: 'PDF' },
      { title: 'Study planner template', type: 'Worksheet' }
    ],
    tutors: [
      { name: 'Aisha', subject: 'Maths' },
      { name: 'Liam', subject: 'English' }
    ]
  },
  tutor: {
    summary: 'You have one new booking request and three sessions scheduled today.',
    sessions: [
      { title: 'Science support', time: 'Today • 2:00 PM', status: 'Scheduled' },
      { title: 'Reading club', time: 'Today • 6:00 PM', status: 'Scheduled' }
    ],
    requests: [
      { name: 'Maya', subject: 'Biology', note: 'Needs help preparing for a test', status: 'Pending' },
      { name: 'Toby', subject: 'English', note: 'Would like a writing workshop', status: 'Pending' }
    ],
    availability: [
      { day: 'Monday', time: '3:00 PM - 6:00 PM' },
      { day: 'Wednesday', time: '5:00 PM - 8:00 PM' }
    ]
  }
};

function getStorageKey(role) {
  return `helloEducation-${role}-dashboard`;
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

export function getDemoDashboardData(role) {
  return cloneData(demoData[role]);
}

export function loadDashboardData(role) {
  const stored = localStorage.getItem(getStorageKey(role));
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (error) {
      console.warn('Unable to read stored dashboard data', error);
    }
  }

  return getDemoDashboardData(role);
}

export async function saveDashboardData(role, data) {
  localStorage.setItem(getStorageKey(role), JSON.stringify(data));

  if (!isFirebaseConfigured()) {
    return;
  }

  try {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const ref = doc(db, role === 'student' ? 'dashboardData' : 'tutorDashboardData', 'main');
    await setDoc(ref, data, { merge: true });
  } catch (error) {
    console.warn('Unable to sync dashboard data to Firestore', error);
  }
}

export async function fetchDashboardData(role) {
  const cached = loadDashboardData(role);

  if (!isFirebaseConfigured()) {
    return cached;
  }

  try {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const snapshot = await getDocs(collection(db, role === 'student' ? 'dashboardData' : 'tutorDashboardData'));
    const docs = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));

    if (docs.length) {
      const remoteData = docs[0];
      localStorage.setItem(getStorageKey(role), JSON.stringify(remoteData));
      return remoteData;
    }
  } catch (error) {
    console.warn('Unable to fetch dashboard data from Firestore', error);
  }

  return cached;
}
