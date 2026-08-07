# Firebase setup for HelloEducation

## 1. Create a Firebase project
1. Go to https://console.firebase.google.com/
2. Create a new project called HelloEducation
3. Register a web app for the project
4. Copy the web config values shown by Firebase

## 2. Enable authentication
1. In Firebase Console, open Authentication
2. Go to the Sign-in method tab
3. Enable Email/Password

## 3. Enable Firestore
1. Open Firestore Database
2. Create a database in test mode
3. Create a collection called users

## 4. Add your config values
Open firebase-config.js and replace the placeholder values with your real Firebase config:

```js
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId: 'YOUR_APP_ID'
};
```

## 5. Deploy the security rules
1. Open Firestore Database → Rules tab in the Firebase console
2. Replace the contents with everything in `firestore.rules` from this repo
3. Click Publish

These rules only let a signed-in user self-create their **own** `users/{uid}`
document with `role: "student"`. Tutor and admin roles can never be
self-assigned — they must be set by an existing admin (see step 6).

## 6. Create the first admin account
Because tutor/admin roles can't be self-assigned, the very first admin has to
be created by hand, once:
1. Firebase console → Authentication → Add user → enter your email + a password
2. Copy the UID shown for that new user
3. Firestore console → `users` collection → Add document → set the document ID
   to that UID, with fields:
   ```json
   {
     "role": "admin",
     "email": "you@example.com",
     "name": "Your Name"
   }
   ```
4. Sign in at `/login.html?role=admin` with that email/password

From then on, use the admin dashboard's "Grant a role" tool to promote other
accounts to tutor or admin — see `firebase-admin-notes.md`.

## 7. Set up tutors and students
Tutors and students sign themselves up:
1. Create their Firebase Auth account (Authentication → Add user), or have
   them sign up if you enable self-serve signup separately
2. Have them sign in once at `/login.html?role=student` — this creates their
   `users/{uid}` document with `role: "student"`
3. As the admin, open `/admin-dashboard.html`, look up their email under
   "Grant a role", and promote them to `tutor` if needed

## 8. Test the login
After the config is filled in, visit:
- /login.html?role=student
- /login.html?role=tutor
- /login.html?role=admin

Sign in with an email/password account that exists in Firebase Authentication.
Tutor and admin logins will be rejected with a "contact the admin" message
until an admin has granted that role via step 6 or 7.
