const detailed = [
  "                                       #,",
  "                                       ###",
  "                                       ####",
  "                                       #####",
  "                                       ######",
  "                                      ########,",
  "                                ,,################,,,,,",
  "                          ,,#################################,,",
  "                     ,,##########################################,,",
  "                  ,#########################################, ''#####,",
  "               ,#############################################,,   '####,",
  "             ,##################################################,,,,####,",
  "           ,###########''''           ''''###############################",
  "         ,#####''   ,,,,##########,,,,          '''####'''          '####",
  "       ,##' ,,,,###########################,,,                        '##",
  "      ' ,,###''''                  '''############,,,",
  "    ,,##''                                '''############,,,,        ,,,,,,###''",
  " ,#''                                            '''#######################'''",
  "'                                                          ''''####''''",
];
const compact = [
  "                   #,",
  "                   ###",
  "                   ####,",
  "             ,#################,",
  "       ,######################,  ###",
  "      ,#########################,,##,",
  "     ,######''     ''################",
  "   ,#',,##############,            ##",
  "  ,#'                '#######,,   ,,,##'",
  "'                            ''###''",
];
const miniature = [
  "              #,",
  "        ,,#########,,",
  "     ,################  ##,",
  "   ,####''    ''############",
  "  ,#' ,,#########,,      '##",
  " '          ''########,,##'",
];

function outline(art) {
  return art.map((line, y) => [...line].map((char, x) => {
    if (char !== '#') return char;
    return [[-1,0],[1,0],[0,-1],[0,1]].every(([dx,dy]) => art[y+dy]?.[x+dx] === '#') ? ' ' : '#';
  }).join(''));
}
function stipple(art) {
  return art.map((line,y) => [...line].map((char,x) => char === '#' ? ['@','o',':','o'][(x + y * 2) % 4] : char).join(''));
}

export const variants = [
  { id:'a', name:'Classic cruise', idea:'The original silhouette with its lower ### wave gently rippling. After the first prompt, a solid fin cruises through a light wake.', art:detailed, fallback:compact, motion:'cruise', fin:['   #,','   ###','  #####'] },
  { id:'b', name:'Ink outline', idea:'An airy outline with a gentle rise and fall. The hollow fin bobs through quiet water.', art:outline(detailed), fallback:outline(compact), motion:'bob', fin:['    /|','   / |',' _/  |'] },
  { id:'c', name:'Rolling swell', idea:'A compact, bold whale with a soft body roll. Its rounded fin rides a slow wave across the bar.', art:compact, fallback:compact, motion:'swell', fin:['   ,#','  ###',' #####'] },
  { id:'d', name:'Surface & dive', idea:'A stippled whale that glides. Its fin surfaces, disappears under the water, then returns farther along.', art:stipple(detailed), fallback:stipple(compact), motion:'dive', fin:['   @,','   @@@','  @@@@@'] },
  { id:'e', name:'Little swimmer', idea:'A small, playful orca with quick tail flicks. A tiny fin makes short passes, leaving little ripples.', art:miniature, fallback:miniature, motion:'little', fin:['  #,',' ###'] },
];

export function whaleFrame(variant, tick, cols) {
  const maxWidth = art => Math.max(...art.map(line => line.length));
  const art = maxWidth(variant.art) + 4 <= cols ? variant.art : variant.fallback;
  const width = maxWidth(art), grid = Array.from({length:22}, () => Array(cols).fill(' '));
  const bob = ['bob','swell'].includes(variant.motion) ? Math.round(Math.sin(tick / 5)) : 0;
  const drift = variant.motion === 'dive' ? Math.round(2 * Math.sin(tick / 9)) : 0;
  const offsetX = Math.floor((cols-width)/2) + drift, offsetY = Math.floor((22-art.length)/2) + bob;
  const tail = Math.round(Math.sin(tick / (variant.motion === 'little' ? 1.6 : 4)));
  const waveStart=art.length-(art.length>12?4:2);
  art.forEach((line,y) => [...line].forEach((char,x) => {
    // Ripple the lower band already drawn in the ASCII art.
    const wave=variant.motion==='cruise' && y>=waveStart && x>=width*.25
      ? Math.round(Math.sin(x/(width*.09)-tick/3.6)) : 0;
    const xx = offsetX + x + (y >= art.length-2 && x < width*.23 ? tail : 0), yy=offsetY+y+wave;
    if (char !== ' ' && grid[yy]?.[xx] !== undefined) grid[yy][xx]=char;
  }));
  return grid.map(row => row.join('')).join('\n');
}

export function finFrame(variant, tick, cols) {
  const rows=6, grid=Array.from({length:rows}, () => Array(cols).fill(' '));
  const draw=(x,y,char) => { if(grid[y]?.[x] !== undefined) grid[y][x]=char; };
  const travel=cols-10, triangle=n => { const phase=n%(travel*2); return phase<travel?phase:travel*2-phase; };
  let x=2+Math.floor(triangle(tick*.55)), base=4, rise=variant.fin.length;
  if(variant.motion==='bob') { x=2+Math.floor(triangle(tick*.32)); base=3+Math.round((Math.sin(tick/5)+1)/2); }
  if(variant.motion==='swell') { x=2+Math.floor(triangle(tick*.3)); base=4; }
  if(variant.motion==='dive') { const phase=tick%40; rise=Math.min(3,Math.max(0,Math.floor(phase<20?phase/3:(32-phase)/3))); x=3+(Math.floor(tick/40)*9)%(cols-11); }
  if(variant.motion==='little') { x=2+Math.floor((tick*.85)%travel); base=4; }

  for(let col=0;col<cols;col++) {
    if(variant.motion==='swell') {
      const y=4+Math.round(Math.sin(col/4-tick/5));
      draw(col,y,Math.sin((col+1)/4-tick/5)>Math.sin(col/4-tick/5)?'~':'_');
    } else {
      draw(col,base,['~','_','_','~','~','_'][(col+Math.floor(tick/2))%6]);
    }
  }
  if(variant.motion==='swell') base=4+Math.round(Math.sin((x+3)/4-tick/5));
  const visible=variant.fin.slice(variant.fin.length-rise);
  visible.forEach((line,y) => [...line].forEach((char,col) => {if(char!==' ') draw(x+col,base-visible.length+y,char);}));
  const finWidth=Math.max(...variant.fin.map(line=>line.length));
  if(rise>0) for(let col=x+1;col<x+finWidth;col++) draw(col,base,variant.motion==='bob'?'_':variant.motion==='dive'?'@':'#');
  if(variant.motion==='cruise'||variant.motion==='little') {
    for(let distance=2;distance<9;distance+=3) draw(x-distance,base+1,'.');
  }
  if(variant.motion==='dive'&&rise===0) {
    const ripple=Math.floor(tick%4)+2;
    draw(x+3-ripple,base,'('); draw(x+3+ripple,base,')');
  }
  return grid.map(row => row.join('')).join('\n');
}
