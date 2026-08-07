export const firebaseConfig = {
  apiKey: 'AIzaSyD9-oFQ64XTR7wz_soIeF3XzclD2YcxOFM',
  authDomain: 'hello-education.firebaseapp.com',
  projectId: 'hello-education',
  storageBucket: 'hello-education.firebasestorage.app',
  messagingSenderId: '240575789629',
  appId: '1:240575789629:web:6afc56becb9baa94484854',
  measurementId: 'G-4PZGCC3485'
};

export function isFirebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.apiKey !== 'YOUR_API_KEY' && firebaseConfig.projectId && firebaseConfig.projectId !== 'YOUR_PROJECT_ID');
}
