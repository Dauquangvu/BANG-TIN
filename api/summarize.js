// api/summarize.js — Tóm tắt bài từ URL (AI Chatbox)
// ?url=https://...
// ENV: AI_API_KEY, AI_BASE_URL, AI_MODEL

function stripHtml(h){
  return (h||'').replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<[^>]+>/g,' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/\s{3,}/g,'\n').trim();
}

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  var url=req.query.url;
  if(!url||!url.startsWith('http')) return res.status(400).json({error:'Thiếu hoặc sai URL'});
  if(!process.env.AI_API_KEY) return res.status(503).json({error:'Chưa cấu hình AI_API_KEY'});
  try{
    // 1. Fetch trang
    var pageRes=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; BangTin/1.0)'},redirect:'follow'});
    if(!pageRes.ok) throw new Error('Không truy cập được trang: HTTP '+pageRes.status);
    var html=await pageRes.text();
    // 2. Lấy title
    var titleMatch=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    var title=titleMatch?stripHtml(titleMatch[1]).slice(0,200):'';
    // 3. Lấy nội dung chính (thử article tag, rồi body)
    var body='';
    var artMatch=html.match(/<article[\s\S]*?<\/article>/i);
    if(artMatch) body=stripHtml(artMatch[0]);
    else{
      var mainMatch=html.match(/<main[\s\S]*?<\/main>/i);
      body=mainMatch?stripHtml(mainMatch[0]):stripHtml(html);
    }
    body=body.slice(0,3000);
    if(body.length<80) throw new Error('Không đọc được nội dung bài viết (trang yêu cầu đăng nhập hoặc chặn bot)');

    // 4. Gọi AI
    var key  = process.env.AI_API_KEY;
    var base = (process.env.AI_BASE_URL||'https://api.anthropic.com').replace(/\/+$/,'');
    var model= process.env.AI_MODEL||'claude-haiku-4-5-20251001';
    var aiRes=await fetch(base+'/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({
        model:model, max_tokens:600,
        messages:[{role:'user',content:'Day la noi dung bai bao:\nTIEU DE: '+title+'\nNOI DUNG:\n'+body+'\n\nHay tom tat bai bao tren bang 4-5 cau tieng Viet ro rang, day du thong tin chinh. Chi tra loi van ban tuan tuy, khong markdown.'}]
      })
    });
    if(!aiRes.ok) throw new Error('AI HTTP '+aiRes.status);
    var d=await aiRes.json();
    var summary=(d.content&&d.content[0]&&d.content[0].text)||'';
    return res.status(200).json({title:title, summary:summary, url:url});
  }catch(e){
    return res.status(500).json({error:e.message});
  }
};
