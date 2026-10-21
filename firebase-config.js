// Firebase web config (not a secret — data is protected by firestore.rules).
// Leave apiKey empty to run in DEMO mode (data stays only in this browser).
export const firebaseConfig = {
  apiKey: 'AIzaSyCcVNSLW4JyxXATxmypgqhs4pTAINNomnM',
  authDomain: 'plandelivery-6ef10.firebaseapp.com',
  projectId: 'plandelivery-6ef10',
  // Realtime Database (Singapore) — used only for the "who is online" counter; leave out to turn it off
  databaseURL: 'https://plandelivery-6ef10-default-rtdb.asia-southeast1.firebasedatabase.app',
  storageBucket: 'plandelivery-6ef10.firebasestorage.app',
  messagingSenderId: '1054319777832',
  appId: '1:1054319777832:web:3d0a8d68c938dfa360fd1d',
  measurementId: 'G-YXT6CJ1Y38',
};

// Firestore collection that holds all app data
export const COLLECTION = 'shipcheck';
