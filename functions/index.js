const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ maxInstances: 5 });

const VALID_ROLES = ['student', 'tutor', 'admin'];

function generateTempPassword() {
  return Math.random().toString(36).slice(-6) + Math.random().toString(36).slice(-6).toUpperCase();
}

async function requireAdmin(auth) {
  const callerUid = auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const callerDoc = await admin.firestore().doc(`users/${callerUid}`).get();
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

  const { email, password, name, role, subject, bio, grade } = request.data || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new HttpsError('invalid-argument', 'A valid email is required.');
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new HttpsError('invalid-argument', 'A name is required.');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', 'Role must be student, tutor, or admin.');
  }

  const usedGeneratedPassword = !password || password.length < 8;
  const finalPassword = usedGeneratedPassword ? generateTempPassword() : password;

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
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

  const batch = admin.firestore().batch();

  batch.set(admin.firestore().doc(`users/${userRecord.uid}`), {
    role,
    email,
    name,
    createdBy: callerUid,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  if (role === 'tutor') {
    batch.set(admin.firestore().doc(`tutors/${userRecord.uid}`), {
      name,
      email,
      subject: subject || '',
      bio: bio || '',
      status: 'active',
      createdBy: callerUid
    });
  }

  if (role === 'student') {
    batch.set(admin.firestore().doc(`students/${userRecord.uid}`), {
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
    tempPassword: usedGeneratedPassword ? finalPassword : null
  };
});