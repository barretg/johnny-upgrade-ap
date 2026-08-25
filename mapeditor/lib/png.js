const fs=require('fs'), zlib=require('zlib');
function readPNG(path){
  const b=fs.readFileSync(path); let p=8; const idat=[]; let W,H,bd,ct;
  while(p<b.length){
    const len=b.readUInt32BE(p), typ=b.slice(p+4,p+8).toString();
    const d=b.slice(p+8,p+8+len);
    if(typ==='IHDR'){W=d.readUInt32BE(0);H=d.readUInt32BE(4);bd=d[8];ct=d[9];}
    if(typ==='IDAT')idat.push(d);
    if(typ==='IEND')break;
    p+=12+len;
  }
  if(bd!==8)throw new Error('bitdepth '+bd);
  const ch={0:1,2:3,4:2,6:4}[ct]; if(!ch)throw new Error('colortype '+ct);
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const stride=W*ch, out=Buffer.alloc(W*H*4);
  let prev=Buffer.alloc(stride), q=0;
  for(let y=0;y<H;y++){
    const ft=raw[q++]; const line=Buffer.from(raw.slice(q,q+stride)); q+=stride;
    for(let i=0;i<stride;i++){
      const a=i>=ch?line[i-ch]:0, bb=prev[i], c=i>=ch?prev[i-ch]:0; let v=line[i];
      if(ft===1)v+=a; else if(ft===2)v+=bb; else if(ft===3)v+=(a+bb)>>1;
      else if(ft===4){const pa=Math.abs(bb-c),pb=Math.abs(a-c),pc=Math.abs(a+bb-2*c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?bb:c);}
      line[i]=v&255;
    }
    prev=line;
    for(let x=0;x<W;x++){
      const o=(y*W+x)*4, i=x*ch;
      if(ch===4){out[o]=line[i];out[o+1]=line[i+1];out[o+2]=line[i+2];out[o+3]=line[i+3];}
      else if(ch===3){out[o]=line[i];out[o+1]=line[i+1];out[o+2]=line[i+2];out[o+3]=255;}
      else if(ch===2){out[o]=out[o+1]=out[o+2]=line[i];out[o+3]=line[i+1];}
      else {out[o]=out[o+1]=out[o+2]=line[i];out[o+3]=255;}
    }
  }
  return {W,H,data:out};
}
function writePNG(path,W,H,data){
  const stride=W*4, raw=Buffer.alloc((stride+1)*H);
  for(let y=0;y<H;y++){raw[y*(stride+1)]=0;data.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);}
  const z=zlib.deflateSync(raw,{level:9});
  const chunks=[Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])];
  const mk=(typ,d)=>{const c=Buffer.alloc(8+d.length+4);c.writeUInt32BE(d.length,0);c.write(typ,4);d.copy(c,8);
    let crc=~0;const tbl=writePNG.tbl||(writePNG.tbl=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})());
    for(let i=4;i<8+d.length;i++)crc=tbl[(crc^c[i])&255]^(crc>>>8);
    c.writeUInt32BE((~crc)>>>0,8+d.length);return c;};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=6;
  chunks.push(mk('IHDR',ihdr),mk('IDAT',z),mk('IEND',Buffer.alloc(0)));
  fs.writeFileSync(path,Buffer.concat(chunks));
}
function crop(src,x,y,w,h){
  const out=Buffer.alloc(w*h*4);
  for(let j=0;j<h;j++)for(let i=0;i<w;i++){
    const sx=x+i, sy=y+j; const o=(j*w+i)*4;
    if(sx<0||sy<0||sx>=src.W||sy>=src.H){out[o+3]=0;continue;}
    src.data.copy(out,o,(sy*src.W+sx)*4,(sy*src.W+sx)*4+4);
  }
  return {W:w,H:h,data:out};
}
function scale(img,f){
  const W=Math.max(1,Math.round(img.W*f)),H=Math.max(1,Math.round(img.H*f));
  const out=Buffer.alloc(W*H*4);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const sx=Math.min(img.W-1,Math.floor(x/f)), sy=Math.min(img.H-1,Math.floor(y/f));
    img.data.copy(out,(y*W+x)*4,(sy*img.W+sx)*4,(sy*img.W+sx)*4+4);
  }
  return {W,H,data:out};
}
module.exports={readPNG,writePNG,crop,scale};
