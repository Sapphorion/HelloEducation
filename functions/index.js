const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

initializeApp();
setGlobalOptions({ maxInstances: 5 });

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const zohoAppPassword = defineSecret('ZOHO_APP_PASSWORD');
const zohoBooksClientId = defineSecret('ZOHO_BOOKS_CLIENT_ID');
const zohoBooksClientSecret = defineSecret('ZOHO_BOOKS_CLIENT_SECRET');
const zohoBooksRefreshToken = defineSecret('ZOHO_BOOKS_REFRESH_TOKEN');
const zohoBooksOrgId = defineSecret('ZOHO_BOOKS_ORG_ID');
const ZOHO_BOOKS_SECRETS = [zohoBooksClientId, zohoBooksClientSecret, zohoBooksRefreshToken, zohoBooksOrgId];

// The mailbox everything is sent from — not secret (it's the visible "from"
// address), so it's a plain constant rather than another secret to set up.
const ZOHO_SENDER_EMAIL = 'info@helloeducation.co.za';
const SITE_URL = 'https://helloeducation.co.za';

const db = getFirestore();
const auth = getAuth();

let cachedTransporter = null;
function getMailTransporter() {
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host: 'smtp.zoho.com',
      port: 465,
      secure: true,
      auth: { user: ZOHO_SENDER_EMAIL, pass: zohoAppPassword.value() }
    });
  }
  return cachedTransporter;
}

// Best-effort email send — failures are logged, never thrown, so a Zoho
// hiccup can't break account creation, assignment posting, etc. for the
// caller who triggered it.
async function sendEmail({ to, subject, html }) {
  if (!to) return;
  try {
    await getMailTransporter().sendMail({
      from: `"HelloEducation" <${ZOHO_SENDER_EMAIL}>`,
      to,
      subject,
      html
    });
  } catch (error) {
    console.error(`Failed to send email to ${to}:`, error.message || error);
  }
}

// --- Zoho Books billing integration (invoices/statements for parents) ---
const ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.com';
const ZOHO_BOOKS_API_URL = 'https://www.zohoapis.com/books/v3';

let cachedZohoBooksToken = null;
let cachedZohoBooksTokenExpiry = 0;

async function getZohoBooksAccessToken() {
  const now = Date.now();
  if (cachedZohoBooksToken && now < cachedZohoBooksTokenExpiry - 60000) {
    return cachedZohoBooksToken;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: zohoBooksClientId.value(),
    client_secret: zohoBooksClientSecret.value(),
    refresh_token: zohoBooksRefreshToken.value()
  });
  const response = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token?${params.toString()}`, { method: 'POST' });
  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`Zoho Books authentication failed: ${data.error || 'unknown error'}`);
  }

  cachedZohoBooksToken = data.access_token;
  cachedZohoBooksTokenExpiry = now + (data.expires_in || 3600) * 1000;
  return cachedZohoBooksToken;
}

async function zohoBooksGet(path, extraParams = {}) {
  const accessToken = await getZohoBooksAccessToken();
  const params = new URLSearchParams({ organization_id: zohoBooksOrgId.value(), ...extraParams });
  const response = await fetch(`${ZOHO_BOOKS_API_URL}${path}?${params.toString()}`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
  });
  const data = await response.json();
  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`Zoho Books API error: ${data.message || data.code}`);
  }
  return data;
}

async function zohoBooksGetPdfBase64(path, extraParams = {}) {
  const accessToken = await getZohoBooksAccessToken();
  const params = new URLSearchParams({ organization_id: zohoBooksOrgId.value(), ...extraParams });
  const response = await fetch(`${ZOHO_BOOKS_API_URL}${path}?${params.toString()}`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Zoho Books PDF request failed (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

// Looks up the Zoho Books contact (customer) whose email matches the
// parent's own Firebase Auth email. email_contains narrows the request, but
// the exact-match filter below is the real security boundary — it protects
// against Zoho ignoring/loosely-matching that query param and handing back
// contacts that merely resemble the search term.
async function findZohoContactIdByEmail(email) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  const data = await zohoBooksGet('/contacts', { email_contains: normalizedEmail, per_page: '200' });
  const contacts = data.contacts || [];
  const match = contacts.find((c) => (c.email || '').trim().toLowerCase() === normalizedEmail);
  return match ? match.contact_id : null;
}

const VALID_ROLES = ['student', 'tutor', 'admin', 'parent', 'matricStudent'];

function generateTempPassword() {
  return Math.random().toString(36).slice(-6) + Math.random().toString(36).slice(-6).toUpperCase();
}

async function requireAdmin(requestAuth) {
  const callerUid = requestAuth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const callerDoc = await db.doc(`users/${callerUid}`).get();
  if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an admin can do this.');
  }

  return callerUid;
}

async function requireTutorOrAdmin(requestAuth) {
  const callerUid = requestAuth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const callerDoc = await db.doc(`users/${callerUid}`).get();
  const role = callerDoc.exists ? callerDoc.data().role : null;
  if (role !== 'tutor' && role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only a tutor or admin can do this.');
  }

  return callerUid;
}

async function requireStudent(requestAuth) {
  const callerUid = requestAuth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const callerDoc = await db.doc(`users/${callerUid}`).get();
  if (!callerDoc.exists || callerDoc.data().role !== 'student') {
    throw new HttpsError('permission-denied', 'Only a student can do this.');
  }

  return { uid: callerUid, email: callerDoc.data().email };
}

// Like requireStudent, but also accepts the Second Chance programme's
// matricStudent role — used only by the shared AI homework helper below,
// since that feature is the same for both cohorts. requestSession stays
// student-only via requireStudent, since Second Chance students don't book
// ad-hoc sessions — they're enrolled in fixed class slots instead.
async function requireAnyStudent(requestAuth) {
  const callerUid = requestAuth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const callerDoc = await db.doc(`users/${callerUid}`).get();
  const role = callerDoc.exists ? callerDoc.data().role : null;
  if (role !== 'student' && role !== 'matricStudent') {
    throw new HttpsError('permission-denied', 'Only a student can do this.');
  }

  return { uid: callerUid, email: callerDoc.data().email };
}

// Uses request.auth.token.email — the verified Firebase Auth email from the
// caller's ID token — rather than the Firestore users/{uid}.email field.
// That Firestore field is self-editable (only role/childUids are locked down
// by the rules), so trusting it here would let a parent point their own
// account at another family's email and pull that family's Zoho invoices.
async function requireParent(requestAuth) {
  const callerUid = requestAuth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const callerDoc = await db.doc(`users/${callerUid}`).get();
  if (!callerDoc.exists || callerDoc.data().role !== 'parent') {
    throw new HttpsError('permission-denied', 'Only a parent can do this.');
  }

  return { uid: callerUid, email: requestAuth.token.email };
}

// Creates a Firebase Auth account plus its Firestore role/profile docs in one
// step. Only callable by an existing admin — the client SDK can't safely do
// this itself because creating a user with createUserWithEmailAndPassword()
// signs the browser in as that new user, kicking out the admin's session.
exports.createAccount = onCall({ secrets: [zohoAppPassword] }, async (request) => {
  const callerUid = await requireAdmin(request.auth);

  const { email, password, name, role, subject, bio, grade, childEmails } = request.data || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new HttpsError('invalid-argument', 'A valid email is required.');
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new HttpsError('invalid-argument', 'A name is required.');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', 'Role must be student, tutor, parent, matricStudent (Second Chance), or admin.');
  }

  let childUids = [];
  let childEmailsNotFound = [];
  if (role === 'parent' && Array.isArray(childEmails) && childEmails.length) {
    const uniqueEmails = [...new Set(childEmails.map((e) => String(e).trim()).filter(Boolean))].slice(0, 30);
    if (uniqueEmails.length) {
      // Filtering role in code (rather than a second .where()) avoids needing
      // a composite index for what's a rare, low-volume admin-only lookup.
      const matches = await db.collection('users').where('email', 'in', uniqueEmails).get();
      const foundEmails = new Set();
      matches.forEach((docSnap) => {
        if (docSnap.data().role !== 'student') return;
        childUids.push(docSnap.id);
        foundEmails.add(docSnap.data().email);
      });
      childEmailsNotFound = uniqueEmails.filter((e) => !foundEmails.has(e));
    }
  }

  const usedGeneratedPassword = !password || password.length < 8;
  const finalPassword = usedGeneratedPassword ? generateTempPassword() : password;

  let userRecord;
  try {
    userRecord = await auth.createUser({
      email,
      password: finalPassword,
      displayName: name
    });
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'An account with that email already exists.');
    }
    throw new HttpsError('internal', error.message || 'Could not create the account.');
  }

  const batch = db.batch();

  const userDoc = {
    role,
    email,
    name,
    createdBy: callerUid,
    createdAt: FieldValue.serverTimestamp()
  };
  if (role === 'parent') {
    userDoc.childUids = childUids;
  }
  batch.set(db.doc(`users/${userRecord.uid}`), userDoc);

  if (role === 'tutor') {
    batch.set(db.doc(`tutors/${userRecord.uid}`), {
      name,
      email,
      subject: subject || '',
      bio: bio || '',
      status: 'active',
      createdBy: callerUid
    });
  }

  if (role === 'student') {
    batch.set(db.doc(`students/${userRecord.uid}`), {
      name,
      email,
      grade: grade || '',
      status: 'active',
      createdBy: callerUid
    });
  }

  if (role === 'matricStudent') {
    batch.set(db.doc(`matricStudents/${userRecord.uid}`), {
      name,
      email,
      subjects: [],
      status: 'active',
      createdBy: callerUid
    });
  }

  await batch.commit();

  const roleLabel = role === 'matricStudent' ? 'Second Chance Programme' : role;
  await sendEmail({
    to: email,
    subject: 'Welcome to HelloEducation',
    html: `
      <p>Hi ${name},</p>
      <p>An account has been created for you on HelloEducation as a <strong>${roleLabel}</strong>.</p>
      ${usedGeneratedPassword ? `
        <p>Your temporary password is: <strong>${finalPassword}</strong></p>
        <p>Please sign in and keep it somewhere safe.</p>
      ` : `
        <p>You can sign in using the password your admin set up with you.</p>
      `}
      <p><a href="${SITE_URL}/login.html">Sign in to HelloEducation</a></p>
    `
  });

  return {
    uid: userRecord.uid,
    email,
    role,
    tempPassword: usedGeneratedPassword ? finalPassword : null,
    childrenLinked: role === 'parent' ? childUids.length : undefined,
    childEmailsNotFound: role === 'parent' && childEmailsNotFound.length ? childEmailsNotFound : undefined
  };
});

// Enables/disables sign-in for an account without deleting its data. Only
// callable by an admin — the client SDK has no way to touch another user's
// Auth record at all.
exports.setAccountDisabled = onCall(async (request) => {
  const callerUid = await requireAdmin(request.auth);
  const { uid, disabled } = request.data || {};

  if (!uid || typeof uid !== 'string') {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  if (uid === callerUid) {
    throw new HttpsError('failed-precondition', "You can't disable your own account.");
  }

  await auth.updateUser(uid, { disabled: Boolean(disabled) });
  await db.doc(`users/${uid}`).update({ disabled: Boolean(disabled) });

  return { uid, disabled: Boolean(disabled) };
});

// Permanently deletes an account: the Auth record, its users/ doc, its
// tutors/ or students/ profile if any, and removes it from any parent's
// linked children. Only callable by an admin, for the same reason as above.
exports.deleteAccount = onCall(async (request) => {
  const callerUid = await requireAdmin(request.auth);
  const { uid } = request.data || {};

  if (!uid || typeof uid !== 'string') {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  if (uid === callerUid) {
    throw new HttpsError('failed-precondition', "You can't delete your own account.");
  }

  const userDoc = await db.doc(`users/${uid}`).get();
  const role = userDoc.exists ? userDoc.data().role : null;

  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') {
      throw new HttpsError('internal', error.message || 'Could not delete the account.');
    }
  }

  const batch = db.batch();
  batch.delete(db.doc(`users/${uid}`));
  if (role === 'tutor') {
    batch.delete(db.doc(`tutors/${uid}`));
  }
  if (role === 'student') {
    batch.delete(db.doc(`students/${uid}`));
  }
  if (role === 'matricStudent') {
    batch.delete(db.doc(`matricStudents/${uid}`));
  }
  await batch.commit();

  if (role === 'student') {
    const parentsWithChild = await db.collection('users')
      .where('role', '==', 'parent')
      .where('childUids', 'array-contains', uid)
      .get();
    await Promise.all(parentsWithChild.docs.map((parentDoc) =>
      parentDoc.ref.update({ childUids: FieldValue.arrayRemove(uid) })
    ));
  }

  if (role === 'matricStudent') {
    const groupsWithStudent = await db.collection('matricGroups')
      .where('studentIds', 'array-contains', uid)
      .get();
    await Promise.all(groupsWithStudent.docs.map((groupDoc) =>
      groupDoc.ref.update({ studentIds: FieldValue.arrayRemove(uid) })
    ));
  }

  return { uid, deleted: true };
});

// A student requests a session with a tutor. Runs server-side (rather than
// a direct client write) so the double-booking check below is trustworthy —
// a client-side check-then-write has a race window two students could both
// slip through.
exports.requestSession = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const callerDoc = await db.doc(`users/${callerUid}`).get();
  const callerRole = callerDoc.exists ? callerDoc.data().role : null;
  if (callerRole !== 'student' && callerRole !== 'parent') {
    throw new HttpsError('permission-denied', 'Only a student or parent can request a session.');
  }

  const { tutorId, subject, scheduledAt, notes, format, studentId: requestedStudentId } = request.data || {};

  let student;
  if (callerRole === 'student') {
    student = { uid: callerUid, email: callerDoc.data().email };
  } else {
    // Parent booking on behalf of a child — childUids is only ever set by
    // an admin (see the users/{uid} update rule), so it's safe to trust
    // directly off the parent's own doc without a second round-trip.
    const childUids = callerDoc.data().childUids || [];
    if (!requestedStudentId || !childUids.includes(requestedStudentId)) {
      throw new HttpsError('permission-denied', 'You can only book sessions for your own linked children.');
    }
    const studentDoc = await db.doc(`users/${requestedStudentId}`).get();
    if (!studentDoc.exists) {
      throw new HttpsError('not-found', 'That student account was not found.');
    }
    student = { uid: requestedStudentId, email: studentDoc.data().email };
  }

  if (!tutorId || typeof tutorId !== 'string') {
    throw new HttpsError('invalid-argument', 'A tutor is required.');
  }
  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    throw new HttpsError('invalid-argument', 'A subject is required.');
  }
  if (format !== 'online' && format !== 'faceToFace') {
    throw new HttpsError('invalid-argument', 'Session format must be online or faceToFace.');
  }
  const scheduledDate = new Date(scheduledAt);
  if (!scheduledAt || Number.isNaN(scheduledDate.getTime())) {
    throw new HttpsError('invalid-argument', 'A valid date/time is required.');
  }
  if (scheduledDate.getTime() < Date.now()) {
    throw new HttpsError('invalid-argument', 'Pick a date/time in the future.');
  }

  const tutorDoc = await db.doc(`tutors/${tutorId}`).get();
  if (!tutorDoc.exists) {
    throw new HttpsError('not-found', 'That tutor was not found.');
  }

  const scheduledTimestamp = Timestamp.fromDate(scheduledDate);

  // Equality-only filters (no orderBy) so this doesn't need a composite
  // index — there's only ever a couple of sessions per exact timestamp.
  const existing = await db.collection('sessions')
    .where('tutorId', '==', tutorId)
    .where('scheduledAt', '==', scheduledTimestamp)
    .get();
  const isTaken = existing.docs.some((docSnap) => ['scheduled', 'pending'].includes(docSnap.data().status));
  if (isTaken) {
    throw new HttpsError('already-exists', 'That slot is no longer available. Please pick another time.');
  }

  const sessionRef = await db.collection('sessions').add({
    studentId: student.uid,
    studentEmail: student.email,
    tutorId,
    subject: subject.trim(),
    scheduledAt: scheduledTimestamp,
    status: 'pending',
    format,
    notes: notes ? String(notes).trim() : '',
    createdAt: FieldValue.serverTimestamp()
  });

  return { sessionId: sessionRef.id };
});

// The booking calendar (student/parent "Request a session") needs to know
// which hours are already taken for a tutor, but the sessions collection's
// security rule can't prove a client-side query filtered by an arbitrary
// tutorId is safe (it only allows resource.data.tutorId == request.auth.uid,
// i.e. the tutor querying their own sessions) — and even if it could, a
// student/parent has no business reading other families' session details
// (email, subject, notes) just to render busy/free cells. So this returns
// only the bare timestamps of already-booked slots for the requested tutor
// and range, nothing else.
exports.getTutorBookedTimes = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const { tutorId, rangeStart, rangeEnd } = request.data || {};
  if (!tutorId || typeof tutorId !== 'string') {
    throw new HttpsError('invalid-argument', 'A tutor is required.');
  }
  const start = new Date(rangeStart);
  const end = new Date(rangeEnd);
  if (!rangeStart || !rangeEnd || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new HttpsError('invalid-argument', 'A valid date range is required.');
  }

  const snapshot = await db.collection('sessions')
    .where('tutorId', '==', tutorId)
    .where('scheduledAt', '>=', Timestamp.fromDate(start))
    .where('scheduledAt', '<', Timestamp.fromDate(end))
    .get();

  const bookedTimes = snapshot.docs
    .map((docSnap) => docSnap.data())
    .filter((s) => s.status === 'scheduled' || s.status === 'pending')
    .map((s) => s.scheduledAt.toDate().getTime());

  return { bookedTimes };
});

// The public (unauthenticated) tutors.html page can't read the tutors
// collection directly — its Firestore rule requires signedIn() — and even
// if it could, a raw collection read would expose every tutor's email and
// the admin uid that created them. This returns just the fields the public
// page actually needs, for tutors an admin has marked visible.
exports.getPublicTutors = onCall(async (request) => {
  const snapshot = await db.collection('tutors').get();

  // A tutor is public unless explicitly hidden — matches the admin editor's
  // own default (admin-accounts.html's status <select> shows "Visible" for
  // anything that isn't literally 'inactive'), rather than requiring every
  // doc to have status: 'active' set, which older/hand-created docs won't.
  const tutors = snapshot.docs
    .filter((docSnap) => docSnap.data().status !== 'inactive')
    .map((docSnap) => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        name: data.name || '',
        subject: data.subject || '',
        bio: data.bio || '',
        photoUrl: data.photoUrl || ''
      };
    });

  return { tutors };
});

// Slots a matric re-write student into an open class group for a subject.
// Server-side because it has to search across matricGroups for room and then
// write two documents (the group roster and the student's subject list) —
// admin-only and low-volume, so a plain read-then-write is enough (no
// transaction) rather than the double-booking-style race guard requestSession
// needs for student self-service.
exports.enrollMatricStudent = onCall(async (request) => {
  await requireAdmin(request.auth);
  const { studentId, subject } = request.data || {};

  if (!studentId || typeof studentId !== 'string') {
    throw new HttpsError('invalid-argument', 'A Second Chance student is required.');
  }
  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    throw new HttpsError('invalid-argument', 'A subject is required.');
  }

  const studentDoc = await db.doc(`matricStudents/${studentId}`).get();
  if (!studentDoc.exists) {
    throw new HttpsError('not-found', 'That Second Chance student was not found.');
  }

  const alreadyEnrolled = (studentDoc.data().subjects || []).includes(subject);

  const groupsSnap = await db.collection('matricGroups').where('subject', '==', subject).get();
  const scheduledGroup = groupsSnap.docs.find((docSnap) => (docSnap.data().studentIds || []).includes(studentId));

  if (alreadyEnrolled && scheduledGroup) {
    return { alreadyEnrolled: true, scheduled: true, groupId: scheduledGroup.id };
  }

  if (!alreadyEnrolled) {
    await db.doc(`matricStudents/${studentId}`).update({ subjects: FieldValue.arrayUnion(subject) });
  }

  if (scheduledGroup) {
    return { alreadyEnrolled, scheduled: true, groupId: scheduledGroup.id };
  }

  // Enrollment itself never depends on a class slot existing or having
  // room — it just adds the subject to the student's roster. If an open
  // slot happens to exist already, opportunistically assign them into it
  // as a convenience; otherwise they stay enrolled-but-unscheduled until
  // an admin assigns them a time slot from that subject's page.
  const openGroup = groupsSnap.docs.find((docSnap) => {
    const data = docSnap.data();
    return (data.studentIds || []).length < (data.capacity || 4);
  });

  if (!openGroup) {
    return { alreadyEnrolled, scheduled: false };
  }

  await openGroup.ref.update({ studentIds: FieldValue.arrayUnion(studentId) });

  const groupData = openGroup.data();
  return {
    alreadyEnrolled,
    scheduled: true,
    groupId: openGroup.id,
    dayOfWeek: groupData.dayOfWeek,
    startTime: groupData.startTime,
    endTime: groupData.endTime,
    tutorName: groupData.tutorName
  };
});

const AI_SYSTEM_PROMPT = `You are a friendly, patient homework helper for HelloEducation, a tutoring service. Your students range from school-age learners to adults completing their matric through the Second Chance Programme, so don't assume a particular age — take your cue from how the student writes. Help with any subject the student asks about: explain concepts clearly, work through problems step by step, and encourage understanding rather than just handing over final answers when it helps their learning.

Keep responses respectful, encouraging, and reasonably concise. If a student asks about something harmful, unsafe, or inappropriate, or something unrelated to schoolwork or learning, gently decline and suggest they speak with their tutor instead.

You are not a replacement for their tutor. For anything requiring real judgment — grades, personal issues, scheduling, disputes — tell them to contact their tutor or the HelloEducation admin.`;

const AI_DAILY_MESSAGE_LIMIT = 40;
const AI_HISTORY_LOOKBACK = 10;

// Student-facing homework helper chatbot. Callable by a student or a Second
// Chance (matricStudent) — checks and increments a per-student daily message
// count in the same transaction so concurrent requests can't slip past the
// cap, then calls the Anthropic API with a short window of prior turns for
// context. Shared across both cohorts since it's the same feature either way.
exports.askAI = onCall({ secrets: [anthropicApiKey] }, async (request) => {
  const student = await requireAnyStudent(request.auth);

  const message = (request.data?.message || '').trim();
  if (!message) {
    throw new HttpsError('invalid-argument', 'A message is required.');
  }
  if (message.length > 2000) {
    throw new HttpsError('invalid-argument', 'Message is too long (2000 characters max).');
  }

  const today = new Date().toISOString().slice(0, 10);
  const usageRef = db.doc(`aiUsage/${student.uid}`);

  await db.runTransaction(async (tx) => {
    const usageDoc = await tx.get(usageRef);
    const data = usageDoc.exists ? usageDoc.data() : {};
    const count = data.date === today ? (data.count || 0) : 0;

    if (count >= AI_DAILY_MESSAGE_LIMIT) {
      throw new HttpsError(
        'resource-exhausted',
        `You've reached today's limit of ${AI_DAILY_MESSAGE_LIMIT} messages. Try again tomorrow, or ask your tutor.`
      );
    }

    tx.set(usageRef, { date: today, count: count + 1 }, { merge: true });
  });

  const messagesRef = db.collection(`aiConversations/${student.uid}/messages`);
  const historySnap = await messagesRef.orderBy('createdAt', 'desc').limit(AI_HISTORY_LOOKBACK).get();
  const history = historySnap.docs
    .map((docSnap) => docSnap.data())
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));

  const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });

  let replyText;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: AI_SYSTEM_PROMPT,
      messages: [...history, { role: 'user', content: message }]
    });
    const textBlock = response.content.find((block) => block.type === 'text');
    replyText = textBlock ? textBlock.text : "Sorry, I couldn't come up with a response — try asking again.";
  } catch (error) {
    console.error('askAI failed:', error.message || error);
    throw new HttpsError('internal', 'Could not reach the AI assistant. Please try again in a moment.');
  }

  const batch = db.batch();
  batch.set(messagesRef.doc(), { role: 'user', content: message, createdAt: FieldValue.serverTimestamp() });
  batch.set(messagesRef.doc(), { role: 'assistant', content: replyText, createdAt: FieldValue.serverTimestamp() });
  await batch.commit();

  return { reply: replyText };
});

// JSON schemas constraining the AI's output to a shape the viewer page and
// the rest of the app can render deterministically, via output_config.format
// rather than free-form text + hope-it-parses.
function materialOutputFormat(type) {
  if (type === 'worksheet') {
    return {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          instructions: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                number: { type: 'integer' },
                text: { type: 'string' }
              },
              required: ['number', 'text'],
              additionalProperties: false
            }
          },
          answerKey: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                number: { type: 'integer' },
                answer: { type: 'string' }
              },
              required: ['number', 'answer'],
              additionalProperties: false
            }
          }
        },
        required: ['title', 'instructions', 'questions', 'answerKey'],
        additionalProperties: false
      }
    };
  }

  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' }
            },
            required: ['heading', 'bullets', 'notes'],
            additionalProperties: false
          }
        }
      },
      required: ['title', 'slides'],
      additionalProperties: false
    }
  };
}

const MATERIAL_SYSTEM_PROMPTS = {
  worksheet: 'You create clear, well-structured worksheets for tutoring students. Questions should build in difficulty and match the requested subject and topic. Provide a complete, correct answer key matching every question by number.',
  slideshow: 'You create clear, well-structured slide decks for tutoring sessions. Each slide has a short heading, concise bullet points (not full paragraphs), and speaker notes with extra detail for the tutor to talk through while presenting.'
};

// Tutor/admin-facing "create a worksheet or slideshow with AI" tool. Returns
// structured JSON (via output_config.format) rather than free text, so the
// material viewer page can render it as a real worksheet/slide deck instead
// of a wall of AI-generated prose.
exports.generateMaterial = onCall({ secrets: [anthropicApiKey] }, async (request) => {
  const callerUid = await requireTutorOrAdmin(request.auth);

  const { type, subject, topic } = request.data || {};

  if (type !== 'worksheet' && type !== 'slideshow') {
    throw new HttpsError('invalid-argument', 'Material type must be worksheet or slideshow.');
  }
  const trimmedTopic = (topic || '').trim();
  if (!trimmedTopic) {
    throw new HttpsError('invalid-argument', 'Describe what the material should cover.');
  }
  if (trimmedTopic.length > 1000) {
    throw new HttpsError('invalid-argument', 'Description is too long (1000 characters max).');
  }
  const trimmedSubject = (subject || '').trim();

  const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });

  let response;
  try {
    response = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: MATERIAL_SYSTEM_PROMPTS[type],
      messages: [{
        role: 'user',
        content: `Subject: ${trimmedSubject || 'General'}\n\nCreate a ${type} covering: ${trimmedTopic}`
      }],
      output_config: { format: materialOutputFormat(type) }
    });
  } catch (error) {
    console.error('generateMaterial failed:', error.message || error);
    throw new HttpsError('internal', 'Could not generate the material. Please try again.');
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new HttpsError('internal', 'The AI did not return any content.');
  }

  let content;
  try {
    content = JSON.parse(textBlock.text);
  } catch (error) {
    throw new HttpsError('internal', 'Could not parse the generated material.');
  }

  const materialRef = await db.collection('materials').add({
    title: content.title,
    type,
    subject: trimmedSubject,
    topic: trimmedTopic,
    content,
    createdBy: callerUid,
    createdAt: FieldValue.serverTimestamp()
  });

  return { materialId: materialRef.id, content };
});

// Returns a parent's invoices, payments, and a computed account statement
// from Zoho Books. Nothing is cached in Firestore — every call reads live
// from Zoho, the same "always fresh, never stale financial data" rule the
// service worker follows for the rest of the site.
exports.getParentBilling = onCall({ secrets: ZOHO_BOOKS_SECRETS }, async (request) => {
  const { email } = await requireParent(request.auth);

  let contactId;
  try {
    contactId = await findZohoContactIdByEmail(email);
  } catch (error) {
    console.error('Zoho Books contact lookup failed:', error.message || error);
    throw new HttpsError('internal', 'Could not reach the billing system. Please try again later.');
  }

  if (!contactId) {
    return { linked: false, invoices: [], payments: [], statement: null };
  }

  let invoicesData, paymentsData;
  try {
    [invoicesData, paymentsData] = await Promise.all([
      zohoBooksGet('/invoices', { customer_id: contactId, per_page: '200' }),
      zohoBooksGet('/customerpayments', { customer_id: contactId, per_page: '200' })
    ]);
  } catch (error) {
    console.error('Zoho Books billing fetch failed:', error.message || error);
    throw new HttpsError('internal', 'Could not load your billing details. Please try again later.');
  }

  // Re-filtering by customer_id here (not just trusting the query param) is
  // a defense-in-depth check against a family ever seeing another family's
  // line items if Zoho's filter is ever loose or ignored.
  const invoices = (invoicesData.invoices || [])
    .filter((inv) => String(inv.customer_id) === String(contactId))
    .map((inv) => ({
      invoiceId: inv.invoice_id,
      invoiceNumber: inv.invoice_number,
      date: inv.date,
      dueDate: inv.due_date,
      status: inv.status,
      total: Number(inv.total) || 0,
      balance: Number(inv.balance) || 0
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const payments = (paymentsData.customerpayments || [])
    .filter((p) => String(p.customer_id) === String(contactId))
    .map((p) => ({
      paymentId: p.payment_id,
      date: p.date,
      amount: Number(p.amount) || 0,
      reference: p.reference_number || p.payment_number || ''
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const totalInvoiced = invoices.reduce((sum, inv) => sum + inv.total, 0);
  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
  const outstandingBalance = invoices.reduce((sum, inv) => sum + inv.balance, 0);

  return {
    linked: true,
    invoices,
    payments,
    statement: { totalInvoiced, totalPaid, outstandingBalance }
  };
});

// Streams a single invoice PDF back to the caller as base64. Ownership is
// re-verified against Zoho directly (not just the customer_id filter used
// for the list above) before any bytes are fetched, so a parent can't view
// another family's invoice by guessing/enumerating an invoice ID.
exports.getInvoicePdf = onCall({ secrets: ZOHO_BOOKS_SECRETS }, async (request) => {
  const { email } = await requireParent(request.auth);
  const { invoiceId } = request.data || {};
  if (!invoiceId || typeof invoiceId !== 'string') {
    throw new HttpsError('invalid-argument', 'An invoice ID is required.');
  }

  let contactId;
  try {
    contactId = await findZohoContactIdByEmail(email);
  } catch (error) {
    console.error('Zoho Books contact lookup failed:', error.message || error);
    throw new HttpsError('internal', 'Could not reach the billing system. Please try again later.');
  }
  if (!contactId) {
    throw new HttpsError('not-found', 'No billing account is linked to your email yet.');
  }

  let invoiceData;
  try {
    invoiceData = await zohoBooksGet(`/invoices/${encodeURIComponent(invoiceId)}`);
  } catch (error) {
    throw new HttpsError('not-found', 'Invoice not found.');
  }
  const invoice = invoiceData.invoice;
  if (!invoice || String(invoice.customer_id) !== String(contactId)) {
    throw new HttpsError('permission-denied', 'That invoice does not belong to your account.');
  }

  let pdfBase64;
  try {
    pdfBase64 = await zohoBooksGetPdfBase64('/invoices/pdf', { invoice_ids: invoiceId });
  } catch (error) {
    console.error('Zoho Books PDF fetch failed:', error.message || error);
    throw new HttpsError('internal', 'Could not download the invoice PDF. Please try again later.');
  }

  return { pdfBase64, filename: `Invoice-${invoice.invoice_number || invoiceId}.pdf` };
});

// --- Email notifications for new assignments/resources/materials and
// question replies. All Firestore-triggered, so they fire regardless of
// whether the write came from a client addDoc() or a Cloud Function — no
// changes needed to the existing tutor/admin forms that create these docs.

exports.onAssignmentCreated = onDocumentCreated({ document: 'assignments/{assignmentId}', secrets: [zohoAppPassword] }, async (event) => {
  const a = event.data.data();
  await sendEmail({
    to: a.studentEmail,
    subject: `New assignment: ${a.title}`,
    html: `
      <p>Hi,</p>
      <p>Your tutor has assigned you something new: <strong>${a.title}</strong>.</p>
      ${a.description ? `<p>${a.description}</p>` : ''}
      <p><a href="${SITE_URL}/login.html?role=student">View it on HelloEducation</a></p>
    `
  });
});

exports.onMatricAssignmentCreated = onDocumentCreated({ document: 'matricAssignments/{assignmentId}', secrets: [zohoAppPassword] }, async (event) => {
  const a = event.data.data();
  const kind = a.type === 'assessment' ? 'assessment' : 'task';
  await sendEmail({
    to: a.studentEmail,
    subject: `New ${kind}: ${a.title}`,
    html: `
      <p>Hi,</p>
      <p>Your tutor has given you a new ${kind}: <strong>${a.title}</strong>${a.dueAt ? ` (due ${a.dueAt.toDate().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })})` : ''}.</p>
      ${a.description ? `<p>${a.description}</p>` : ''}
      <p><a href="${SITE_URL}/login.html?role=matricStudent">View it on HelloEducation</a></p>
    `
  });
});

exports.onStudyResourceCreated = onDocumentCreated({ document: 'studyResources/{resourceId}', secrets: [zohoAppPassword] }, async (event) => {
  const r = event.data.data();
  await sendEmail({
    to: r.studentEmail,
    subject: `New study resource: ${r.title}`,
    html: `
      <p>Hi,</p>
      <p>A new study resource has been shared with you: <strong>${r.title}</strong> (${r.type}).</p>
      <p><a href="${SITE_URL}/login.html?role=student">View it on HelloEducation</a></p>
    `
  });
});

exports.onMatricStudyResourceCreated = onDocumentCreated({ document: 'matricStudyResources/{resourceId}', secrets: [zohoAppPassword] }, async (event) => {
  const r = event.data.data();
  await sendEmail({
    to: r.studentEmail,
    subject: `New study resource: ${r.title}`,
    html: `
      <p>Hi,</p>
      <p>A new study resource has been shared with you: <strong>${r.title}</strong> (${r.type}).</p>
      <p><a href="${SITE_URL}/login.html?role=matricStudent">View it on HelloEducation</a></p>
    `
  });
});

exports.onMatricSessionMaterialCreated = onDocumentCreated({ document: 'matricSessionMaterials/{materialId}', secrets: [zohoAppPassword] }, async (event) => {
  const m = event.data.data();
  const studentIds = m.studentIds || [];
  await Promise.all(studentIds.map(async (studentId) => {
    const studentDoc = await db.doc(`matricStudents/${studentId}`).get();
    if (!studentDoc.exists) return;
    await sendEmail({
      to: studentDoc.data().email,
      subject: `New session material: ${m.title}`,
      html: `
        <p>Hi,</p>
        <p>New material has been posted for your ${m.subject} session on ${m.date}: <strong>${m.title}</strong>.</p>
        <p><a href="${SITE_URL}/matric-session.html?groupId=${m.groupId}&date=${m.date}">View it on HelloEducation</a></p>
      `
    });
  }));
});

exports.onQuestionAnswered = onDocumentUpdated({ document: 'questions/{questionId}', secrets: [zohoAppPassword] }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === 'answered' || after.status !== 'answered') return;
  await sendEmail({
    to: after.studentEmail,
    subject: `Your tutor replied: ${after.subject}`,
    html: `
      <p>Hi,</p>
      <p>Your tutor replied to your question about <strong>${after.subject}</strong>:</p>
      <p>${after.reply}</p>
      <p><a href="${SITE_URL}/login.html?role=student">View it on HelloEducation</a></p>
    `
  });
});

exports.onMatricQuestionAnswered = onDocumentUpdated({ document: 'matricQuestions/{questionId}', secrets: [zohoAppPassword] }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === 'answered' || after.status !== 'answered') return;
  await sendEmail({
    to: after.studentEmail,
    subject: `Your tutor replied: ${after.subject}`,
    html: `
      <p>Hi,</p>
      <p>Your tutor replied to your question about <strong>${after.subject}</strong>:</p>
      <p>${after.reply}</p>
      <p><a href="${SITE_URL}/login.html?role=matricStudent">View it on HelloEducation</a></p>
    `
  });
});

// --- Daily session reminders, 07:00 SAST. South Africa has no DST, so a
// fixed +2h offset from UTC is always correct — no timezone library needed.

function sastNow() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}

// Returns the real UTC instants for the start/end of "today" in SAST, plus
// a YYYY-MM-DD key for that SAST calendar date — computed via the shifted-
// date trick above rather than a timezone library.
function sastDayBoundsUtc() {
  const shifted = sastNow();
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const startUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - 2 * 60 * 60 * 1000);
  const endUtc = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - 2 * 60 * 60 * 1000);
  const dateKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { startUtc, endUtc, dateKey };
}

exports.sendSessionReminders = onSchedule({
  schedule: '0 7 * * *',
  timeZone: 'Africa/Johannesburg',
  secrets: [zohoAppPassword]
}, async () => {
  const { startUtc, endUtc, dateKey } = sastDayBoundsUtc();
  const startTs = Timestamp.fromDate(startUtc);
  const endTs = Timestamp.fromDate(endUtc);

  // General tutoring: sessions scheduled for today.
  const sessionsSnap = await db.collection('sessions')
    .where('status', '==', 'scheduled')
    .where('scheduledAt', '>=', startTs)
    .where('scheduledAt', '<=', endTs)
    .get();

  await Promise.all(sessionsSnap.docs.map(async (docSnap) => {
    const s = docSnap.data();
    if (s.reminderSent) return;
    await sendEmail({
      to: s.studentEmail,
      subject: `Reminder: ${s.subject} today`,
      html: `
        <p>Hi,</p>
        <p>Just a reminder — you have a ${s.subject} session today at ${s.scheduledAt.toDate().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' })}.</p>
        ${s.meetingLink ? `<p><a href="${s.meetingLink}">Join session</a></p>` : ''}
      `
    });
    await docSnap.ref.update({ reminderSent: true });
  }));

  // Second Chance: recurring class slots whose weekly day matches today.
  const dayOfWeek = sastNow().getUTCDay();
  const groupsSnap = await db.collection('matricGroups').where('dayOfWeek', '==', dayOfWeek).get();

  await Promise.all(groupsSnap.docs.map(async (groupDoc) => {
    const g = groupDoc.data();
    const reminderRef = db.doc(`matricGroupReminders/${groupDoc.id}_${dateKey}`);
    const reminderSnap = await reminderRef.get();
    if (reminderSnap.exists) return;

    const studentIds = g.studentIds || [];
    await Promise.all(studentIds.map(async (studentId) => {
      const studentDoc = await db.doc(`matricStudents/${studentId}`).get();
      if (!studentDoc.exists) return;
      await sendEmail({
        to: studentDoc.data().email,
        subject: `Reminder: ${g.subject} today`,
        html: `
          <p>Hi,</p>
          <p>Just a reminder — you have ${g.subject} today from ${g.startTime} to ${g.endTime} with ${g.tutorName}.</p>
          ${g.meetingLink ? `<p><a href="${g.meetingLink}">Join session</a></p>` : ''}
        `
      });
    }));

    await reminderRef.set({ sentAt: FieldValue.serverTimestamp() });
  }));
});