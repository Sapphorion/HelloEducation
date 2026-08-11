const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const Anthropic = require('@anthropic-ai/sdk');

initializeApp();
setGlobalOptions({ maxInstances: 5 });

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');

const db = getFirestore();
const auth = getAuth();

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

// Creates a Firebase Auth account plus its Firestore role/profile docs in one
// step. Only callable by an existing admin — the client SDK can't safely do
// this itself because creating a user with createUserWithEmailAndPassword()
// signs the browser in as that new user, kicking out the admin's session.
exports.createAccount = onCall(async (request) => {
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
  const student = await requireStudent(request.auth);
  const { tutorId, subject, scheduledAt, notes, format } = request.data || {};

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

  const groupsSnap = await db.collection('matricGroups').where('subject', '==', subject).get();

  const alreadyIn = groupsSnap.docs.find((docSnap) => (docSnap.data().studentIds || []).includes(studentId));
  if (alreadyIn) {
    return { groupId: alreadyIn.id, alreadyEnrolled: true };
  }

  const openGroup = groupsSnap.docs.find((docSnap) => {
    const data = docSnap.data();
    return (data.studentIds || []).length < (data.capacity || 4);
  });

  if (!openGroup) {
    throw new HttpsError(
      'failed-precondition',
      `No open class slot for ${subject} — create a new class slot for this subject first, then try again.`
    );
  }

  await openGroup.ref.update({ studentIds: FieldValue.arrayUnion(studentId) });
  await db.doc(`matricStudents/${studentId}`).update({ subjects: FieldValue.arrayUnion(subject) });

  const groupData = openGroup.data();
  return {
    groupId: openGroup.id,
    subject,
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
    throw new HttpsError('internal', 'Could not reach the AI assistant. Please try again in a moment.');
  }

  const batch = db.batch();
  batch.set(messagesRef.doc(), { role: 'user', content: message, createdAt: FieldValue.serverTimestamp() });
  batch.set(messagesRef.doc(), { role: 'assistant', content: replyText, createdAt: FieldValue.serverTimestamp() });
  await batch.commit();

  return { reply: replyText };
});