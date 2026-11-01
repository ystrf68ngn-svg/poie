import type { MarketDataset } from './market-data.ts';
import { marketSummary } from './market-data.ts';

// Deterministic slice-and-dice treemap: area is the actual volume in lots. No model
// generated coordinates, prices, or industry classifications enter this chart.
export function marketChart(dataset: MarketDataset) {
  const escape = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const rows = [...dataset.rows].sort((a,b) => b.volumeLots-a.volumeLots);
  type Tile = { row: typeof rows[number]; x:number; y:number; w:number; h:number };
  const tiles: Tile[] = [];
  function split(items: typeof rows, x:number, y:number, w:number, h:number) {
    if (!items.length) return;
    if (items.length === 1) { tiles.push({row:items[0],x,y,w,h}); return; }
    const total=items.reduce((n,r)=>n+Math.max(r.volumeLots,1),0); let weight=0,cut=1;
    for (let i=0;i<items.length-1;i++) { weight+=Math.max(items[i].volumeLots,1);cut=i+1;if(weight>=total/2)break; }
    const fraction=weight/total;
    if(w>=h){split(items.slice(0,cut),x,y,w*fraction,h);split(items.slice(cut),x+w*fraction,y,w*(1-fraction),h);}
    else{split(items.slice(0,cut),x,y,w,h*fraction);split(items.slice(cut),x,y+h*fraction,w,h*(1-fraction));}
  }
  split(rows,20,110,960,530);
  const colors=(pct:number)=>pct>0?`hsl(4 64% ${Math.max(30,65-Math.abs(pct)*2)}%)`:pct<0?`hsl(156 44% ${Math.max(24,52-Math.abs(pct)*2)}%)`:'#63716f';
  const rects=tiles.map(t=>`<g data-code="${t.row.code}"><title>${escape(t.row.name)} ${t.row.code}；${t.row.price}元；${t.row.changePercent}%；成交量${t.row.volumeLots}手；${t.row.quoteTime}</title><rect x="${t.x.toFixed(2)}" y="${t.y.toFixed(2)}" width="${Math.max(0,t.w-1).toFixed(2)}" height="${Math.max(0,t.h-1).toFixed(2)}" fill="${colors(t.row.changePercent)}"/>${t.w>62&&t.h>34?`<text x="${(t.x+6).toFixed(2)}" y="${(t.y+17).toFixed(2)}" font-size="11" fill="white">${escape(t.row.name.slice(0,6))}</text><text x="${(t.x+6).toFixed(2)}" y="${(t.y+31).toFixed(2)}" font-size="11" fill="white">${t.row.changePercent>0?'+':''}${t.row.changePercent}%</text>`:''}</g>`).join('');
  const stats=marketSummary(dataset);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="710" viewBox="0 0 1000 710" role="img" aria-label="${dataset.rows.length}只样本股票成交量与涨跌幅树状图"><rect width="1000" height="710" fill="#faf9f6"/><g font-family="-apple-system,Microsoft YaHei,sans-serif"><text x="20" y="34" font-size="22" fill="#282724">沪深样本行情 · ${dataset.rows.length}只股票</text><text x="20" y="60" font-size="13" fill="#665e55">数据日期 ${dataset.dataDate} · 面积：成交量（手） · 颜色：涨跌幅（红涨绿跌）</text><text x="20" y="85" font-size="13" fill="#665e55">上涨 ${stats.rising} / 下跌 ${stats.falling} / 平盘 ${stats.flat} · 等权平均 ${stats.meanChangePercent}%</text>${rects}<text x="20" y="670" font-size="12" fill="#665e55">腾讯财经最新返回快照；分层样本不代表全市场。停牌/零成交量以最小可见面积标注。</text><text x="20" y="692" font-size="11" fill="#857d74">数据集 ${dataset.id} · 获取时间 ${dataset.retrievedAt}</text></g></svg>`;
}
