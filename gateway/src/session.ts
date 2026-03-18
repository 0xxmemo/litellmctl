// Custom MongoDB Store for hono-sess
// Implements the Store interface for MongoDB

import { Store } from 'hono-sess'
import { MongoClient, ObjectId } from 'mongodb'
import type { ExtendedHonoRequest, SessionData } from 'hono-sess'

export class MongoStore extends Store {
  private client: MongoClient
  private dbName: string
  private collectionName: string
  private collection: any
  // touchAfter: only persist session touch once per N seconds (default 1 day)
  // Reduces MongoDB write load for active sessions significantly.
  private touchAfter: number
  private touchTimestamps: Map<string, number>

  constructor(mongoUrl: string, dbName: string, collectionName: string, options?: { touchAfter?: number }) {
    super()
    this.client = new MongoClient(mongoUrl)
    this.dbName = dbName
    this.collectionName = collectionName
    this.touchAfter = options?.touchAfter ?? 86400 // 1 day in seconds
    this.touchTimestamps = new Map()
    this.connect()
  }

  private async connect() {
    try {
      await this.client.connect()
      const db = this.client.db(this.dbName)
      this.collection = db.collection(this.collectionName)
      this.emit('connect')
    } catch (err) {
      this.emit('disconnect')
      throw err
    }
  }

  async get(sid: string, callback: (err: any, session?: SessionData | null) => void) {
    try {
      if (!this.collection) {
        await this.connect()
      }
      
      const doc = await this.collection.findOne({ _id: sid })
      if (!doc) {
        return callback(null, null)
      }
      
      // Parse session data
      let sessionData = doc.session
      if (typeof sessionData === 'string') {
        sessionData = JSON.parse(sessionData)
      }
      
      callback(null, sessionData)
    } catch (err) {
      callback(err)
    }
  }

  async set(sid: string, session: SessionData, callback?: (err?: any) => void) {
    try {
      if (!this.collection) {
        await this.connect()
      }
      
      console.log(`[MongoStore.set] Saving session for ${sid}: email=${(session as any).email}, role=${(session as any).role}`)
      
      // Parse session data if it's a string
      let sessionData = session
      if (typeof session === 'string') {
        sessionData = JSON.parse(session)
      }
      
      // Ensure cookie expires is a Date object
      if (sessionData.cookie?.expires && typeof sessionData.cookie.expires === 'string') {
        sessionData.cookie.expires = new Date(sessionData.cookie.expires)
      }
      
      // The session is already an object with all properties set
      // We need to store the whole session object
      const sessionJson = JSON.stringify(sessionData)
      console.log(`[MongoStore.set] Session JSON: ${sessionJson.substring(0, 200)}...`)
      
      // Update or insert session
      await this.collection.updateOne(
        { _id: sid },
        {
          $set: {
            _id: sid,
            session: sessionJson,
            expires: new Date(sessionData.cookie?.expires || Date.now() + 365 * 24 * 60 * 60 * 1000)
          }
        },
        { upsert: true }
      )
      
      console.log(`[MongoStore.set] Session saved successfully`)
      callback?.()
    } catch (err) {
      console.error(`[MongoStore.set] Error saving session:`, err)
      callback?.(err)
    }
  }

  async destroy(sid: string, callback?: (err?: any) => void) {
    try {
      if (!this.collection) {
        await this.connect()
      }
      
      await this.collection.deleteOne({ _id: sid })
      callback?.()
    } catch (err) {
      callback?.(err)
    }
  }

  async touch(sid: string, session: SessionData, callback?: (err?: any) => void) {
    try {
      if (!this.collection) {
        await this.connect()
      }

      // touchAfter optimization: skip DB write if session was touched recently
      const lastTouch = this.touchTimestamps.get(sid)
      const now = Date.now()
      if (lastTouch && (now - lastTouch) < this.touchAfter * 1000) {
        // Not yet time to update — skip the DB write
        return callback?.()
      }
      this.touchTimestamps.set(sid, now)

      // Update expires time
      const expires = new Date(session.cookie?.expires || Date.now() + 365 * 24 * 60 * 60 * 1000)
      
      await this.collection.updateOne(
        { _id: sid },
        { $set: { expires: expires } }
      )
      
      callback?.()
    } catch (err) {
      callback?.(err)
    }
  }

  async close() {
    await this.client.close()
  }
}
