export async function POST(req:Request){
  await req.arrayBuffer();
  return Response.json({error:'Order entry has been retired. Use the bot controls.'},{status:410});
}
