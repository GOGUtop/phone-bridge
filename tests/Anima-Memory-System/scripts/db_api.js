export async function callBackend(endpoint,payload) {
  (window.memoryCalls ||= []).push({endpoint,payload});
  if(endpoint==='/insert') {
    (window.vectorRows ||= new Map()).set(payload.uuid,{...payload,vectorId:payload.uuid});
    return {vectorId:payload.uuid};
  }
  if(endpoint==='/query')return {chat_results:[...(window.vectorRows?.values()||[])].filter(r=>payload.chatContext.ids.includes(r.collectionId))};
  throw new Error('Unknown mock endpoint');
}
