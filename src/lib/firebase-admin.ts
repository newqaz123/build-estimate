import type { Firestore } from 'firebase-admin/firestore'
import type { Bucket } from '@google-cloud/storage'

let dbInstance!: Firestore
let bucketInstance!: Bucket

function getFirebase() {
  if (dbInstance && bucketInstance) return { db: dbInstance, bucket: bucketInstance }

  const { cert, getApps, initializeApp } = require('firebase-admin/app')
  const { getFirestore } = require('firebase-admin/firestore')
  const { getStorage } = require('firebase-admin/storage')

  const apps = getApps()
  const app = apps.length
    ? apps[0]
    : initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      })

  dbInstance = getFirestore(app)
  bucketInstance = getStorage(app).bucket()
  return { db: dbInstance, bucket: bucketInstance }
}

export function getDb(): Firestore {
  return getFirebase().db
}

export function getStorageBucket(): Bucket {
  return getFirebase().bucket
}
