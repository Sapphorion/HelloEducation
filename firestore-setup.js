// Firestore setup helper for HelloEducation
// Run this in the browser console after the site is loaded, or use it as a reference for your Firebase console.

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import { getFirestore, collection, doc, setDoc } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// Reuse the default app if a page (e.g. login.html) already initialized one —
// calling initializeApp twice throws app/duplicate-app and aborts the module.
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);

export async function createUserRoleDocument(uid, role, email = '', name = '') {
  const ref = doc(db, 'users', uid);
  await setDoc(ref, {
    role,
    email,
    name,
    createdAt: new Date().toISOString()
  });
}

export async function seedDashboardData() {
  const studentRef = doc(db, 'dashboardData', 'main');
  await setDoc(studentRef, {
    summary: 'You have two upcoming sessions and three new study resources.',
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
  });

  const tutorRef = doc(db, 'tutorDashboardData', 'main');
  await setDoc(tutorRef, {
    summary: 'You have one new booking request and three sessions scheduled today.',
    sessions: [
      { title: 'Science support', time: 'Today • 2:00 PM' },
      { title: 'Reading club', time: 'Today • 6:00 PM' }
    ],
    requests: [
      { name: 'Maya', subject: 'Biology', note: 'Needs help preparing for a test' },
      { name: 'Toby', subject: 'English', note: 'Would like a writing workshop' }
    ],
    availability: [
      { day: 'Monday', time: '3:00 PM - 6:00 PM' },
      { day: 'Wednesday', time: '5:00 PM - 8:00 PM' }
    ]
  });
}
