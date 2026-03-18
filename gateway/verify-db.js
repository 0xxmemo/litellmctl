import { MongoClient } from 'mongodb';
import 'dotenv/config';

async function verifyDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('llm-gateway');
  
  console.log('=== OTPs Collection ===');
  const otps = await db.collection('otps').find().sort({createdAt: -1}).limit(5).toArray();
  otps.forEach(doc => {
    console.log(`Email: ${doc.email}, Code: ${doc.code}, Used: ${doc.used}, Expires: ${doc.expiresAt}`);
  });
  
  console.log('\n=== Validated Users Collection ===');
  const users = await db.collection('validated_users').find({email: /example.com/}).sort({createdAt: -1}).limit(5).toArray();
  users.forEach(doc => {
    console.log(`Email: ${doc.email}, Role: ${doc.role}, Created: ${doc.createdAt}`);
  });
  
  console.log('\n=== Access Requests Collection ===');
  const requests = await db.collection('access_requests').find({email: /example.com/}).sort({requestedAt: -1}).limit(5).toArray();
  requests.forEach(doc => {
    console.log(`Email: ${doc.email}, Status: ${doc.status}, Requested: ${doc.requestedAt}`);
  });
  
  await client.close();
}

verifyDB().catch(console.error);
