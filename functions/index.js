const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
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