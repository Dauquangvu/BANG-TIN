// api/news.js — RSS fetch + optional AI summary
// ?type=thegioi|trongnuoc  &ai=1 (chỉ gọi khi có &ai=1)
// ENV: AI_API_KEY, AI_BASE_URL (vd: https://1gw.gwai.cloud), AI_MODEL

var RSS = {
  thegioi:   'https://vnexpress.net/rss/the-gioi.rss',
  trongnuoc: 'https://vnexpress.net/rss/thoi-su.rss'
};

function strip(h) {
  return (h||'').replace(/<[^>]+>/g,' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/\s+/g,' ').trim();
}

function parseRSS(xml) {
  var items=[], re=/<item[^>]*>([\s\S]*?)<\/item>/g, m;
  while((m=re.exec(xml))!==null){
    var b=m[1];
    function get(t){
      var r=new RegExp('<'+t+'[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</'+t+'>','i');
      var f=r.exec(b); return f?f[1].trim():'';
    }
    var title=strip(get('title')), link=(get('link')||get('guid')).trim();
    var desc=strip(get('description')), pub=get('pubDate');
    if(title&&link) items.push({title:title,link:link,excerpt:desc.slice(0,350),pubDate:pub});
    if(items.length>=2) break;
  }
  return items;
}

async function aiSummarize(items){
  var key  = process.env.AI_API_KEY;
  var base = (process.env.AI_BASE_URL||'https://api.anthropic.com').replace(/\/+$/,'');
  var model= process.env.AI_MODEL||'claude-haiku-4-5-20251001';
  var prompt = items.map(function(it,i){
    return 'BAI '+(i+1)+':\nTIEU DE: '+it.title+'\nMO TA: '+it.excerpt;
  }).join('\n\n---\n\n');

  var resp = await fetch(base+'/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({
      model:model, max_tokens:800,
      messages:[{role:'user',content:'Tom tat ngan gon MOI bai sau bang 4-5 cau tieng Viet day du thong tin. Tra ve JSON array '+items.length+' chuoi. Chi JSON thuan, khong markdown.\n\n'+prompt}]
    })
  });
  if(!resp.ok) throw new Error('AI HTTP '+resp.status+': '+(await resp.text()).slice(0,120));
  var d=await resp.json();
  var t=(d.content&&d.content[0]&&d.content[0].text)||'[]';
  return JSON.parse(t.replace(/```json|```/g,'').trim());
}

module.exports = async function(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  var type=req.query.type, useAI=(req.query.ai==='1');
  if(!RSS[type]) return res.status(400).json({error:'type: thegioi hoac trongnuoc'});
  try{
    var rss=await fetch(RSS[type],{headers:{'User-Agent':'BangTin/1.0'}});
    if(!rss.ok) throw new Error('RSS '+rss.status);
    var items=parseRSS(await rss.text());
    // AI CHI CHAY KHI useAI===true VA co key
    if(useAI && process.env.AI_API_KEY && items.length>0){
      try{
        var sums=await aiSummarize(items);
        items.forEach(function(it,i){it.summary=sums[i]||null;});
      }catch(e){
        console.warn('AI skip:',e.message);
        items.forEach(function(it){it.aiError='AI lỗi: '+e.message.slice(0,80);});
      }
    }
    return res.status(200).json({items:items, aiUsed:useAI});
  }catch(e){
    return res.status(500).json({error:e.message});
  }
};
