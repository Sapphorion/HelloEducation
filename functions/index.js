const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

initializeApp();
setGlobalOptions({ maxInstances: 5 });

const db = getFirestore();
const auth = getAuth();

const VALID_ROLES = ['student', 'tutor', 'admin', 'parent'];

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
    throw new HttpsError('permission-denied', 'Only a student can request a session.');
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
    throw new HttpsError('invalid-argument', 'Role must be student, tutor, parent, or admin.');
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

  return { uid, deleted: true };
});

// A student requests a session with a tutor. Runs server-side (rather than
// a direct client write) so the double-booking check below is trustworthy —
// a client-side check-then-write has a race window two students could both
// slip through.
exports.requestSession = onCall(async (request) => {
  const student = await requireStudent(request.auth);
  const { tutorId, subject, scheduledAt, notes } = request.data || {};

  if (!tutorId || typeof tutorId !== 'string') {
    throw new HttpsError('invalid-argument', 'A tutor is required.');
  }
  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    throw new HttpsError('invalid-argument', 'A subject is required.');
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
    notes: notes ? String(notes).trim() : '',
    createdAt: FieldValue.serverTimestamp()
  });

  return { sessionId: sessionRef.id };
});