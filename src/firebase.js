// src/firebase.js
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// TODO: Replace with your Firebase config from Firebase Console
const firebaseConfig = {
  apiKey: "AIzaSyDmyavKCae-Y15Mxh0_mRrzVKE0ZWPXs8s",
  authDomain: "crypto-escrow-a1e1e.firebaseapp.com",
  projectId: "crypto-escrow-a1e1e",
  storageBucket: "crypto-escrow-a1e1e.firebasestorage.app",
  messagingSenderId: "1027116438317",
  appId: "1:1027116438317:web:20e6482f331e88a066b9a4"
};


// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize services
export const auth = getAuth(app);
export const db = getFirestore(app);

export default app;