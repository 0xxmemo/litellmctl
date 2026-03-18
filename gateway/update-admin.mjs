import { MongoClient } from 'mongodb';

async function updateToAdmin() {
  const client = new MongoClient('mongodb+srv://memo_admin:+8KCAdHHo2eWHP5elJfb4w==@memo-cluster.ar9cndp.mongodb.net/llm-gateway?retryWrites=true&w=majority');
  
  try {
    await client.connect();
    const db = client.db('llm-gateway');
    const validatedUsers = db.collection('validated_users');
    
    const result = await validatedUsers.updateOne(
      { email: 'mguleryuz3@gmail.com' },
      { $set: { role: 'admin' } }
    );
    
    console.log('Updated:', result.modifiedCount, 'document(s)');
    
    const user = await validatedUsers.findOne({ email: 'mguleryuz3@gmail.com' });
    console.log('User now:', JSON.stringify(user, null, 2));
  } finally {
    await client.close();
  }
}

updateToAdmin().catch(console.error);
