// Temporary ASCII studies. Every option uses the same clock and killer-whale anatomy.
export const variants = [
  { id: 'a', name: 'cruise', blurb: 'A compact killer whale beside the project details. A gentle tail stroke keeps the header quiet.', size: '6 rows', layout: 'compact' },
  { id: 'b', name: 'surface', blurb: 'A whale surfaces through a quiet waterline above the tabs, then slips beneath it.', size: '7 rows', layout: 'waterline' },
  { id: 'c', name: 'breach', blurb: 'An upright whale rises above the water. A larger, more expressive companion.', size: '10 rows', layout: 'breach' },
  { id: 'd', name: 'deep dive', blurb: 'A whale at the right edge dips beneath the surface, leaving the project details on the left.', size: '7 rows', layout: 'split' },
  { id: 'e', name: 'the pod', blurb: 'Two killer whales travel together above a full-width project strip.', size: '8 rows', layout: 'pod' },
  { id: 'f', name: 'passing through', blurb: 'One whale cruises across an open-water lane. All the information stays beneath it.', size: '6 rows', layout: 'lane' },
];

const whale = [
  '                  /|',
  '         ________/ |_____',
  "\\___..--'###########(  )#`-.",
  ' >########################_)',
  "/___..--.######    _____.-'",
  '         `----.\\ /',
  '                V',
];
const small = [
  '              /|',
  '     ________/ |____',
  "\\__-'#########( )##`-.",
  ' >##################_)',
  "/__..-.####    __.-'",
  '       `---.\\_/',
];
const calf = [
  '         /|',
  "\\_..---' |____",
  ' >########()##_)',
  "/_..---.##__.-'",
  '        \\/',
];
const breach = [
  '             .--.',
  '            /#()#\\',
  '           /######)',
  '       ___/######/',
  '      /  #######/',
  '     /__/####  /',
  '        \\###\\_/',
  '         \\#/',
  '        _/ \\_',
  '       /_   _\\',
];

const heights = { a: 6, b: 7, c: 10, d: 7, e: 8, f: 6 };
function stamp(grid, art, x, y, reverse = false, stroke = 0) {
  const width = Math.max(...art.map(row => row.length));
  const posed = art.map(row => row.padEnd(width));
  if (stroke && art !== breach) {
    // Only the flukes change; the dorsal fin, eye patch and body remain legible.
    const line = art === whale ? 3 : art === small ? 3 : 2;
    posed[line] = (stroke === 1 ? ' }' : ' >') + posed[line].slice(2);
  }
  for (let row = 0; row < posed.length; row++) {
    let line = posed[row];
    if (reverse) line = [...line].reverse().map(c => ({ '/':'\\', '\\':'/', '(':')', ')':'(', '>':'<', '}':'{' }[c] ?? c)).join('');
    for (let col = 0; col < line.length; col++) {
      const px = Math.round(x) + col, py = Math.round(y) + row;
      if (py >= 0 && py < grid.length && px >= 0 && px < grid[py].length && line[col] !== ' ') grid[py][px] = line[col];
    }
  }
}
function water(grid, row, t) {
  for (let x = 0; x < grid[row].length; x++) {
    if (grid[row][x] !== ' ') continue;
    if ((x + Math.floor(t * 2)) % 17 < 3) grid[row][x] = '~';
    else if (x % 11 === 0) grid[row][x] = '.';
  }
}
export function frame(id, cols, seconds, active = true) {
  const t = active ? seconds : 0;
  const width = Math.max(30, cols), g = Array.from({length:heights[id]},()=>Array(width).fill(' '));
  const stroke = active ? Math.floor(t * 1.5) % 2 : 0;
  if (id === 'a') stamp(g,small,2 + Math.sin(t*.65),0,false,stroke);
  else if (id === 'b') {
    const depth = active ? Math.round((Math.sin(t*.7)+1)*1.5) : 0;
    stamp(g,whale,width/2-14+Math.sin(t*.3)*3,depth,false,stroke);
    g[6].fill(' '); water(g,6,t);
  } else if (id === 'c') {
    const lift = active ? Math.round(Math.sin(t*.75)+1) : 2;
    stamp(g,breach,(width-22)/2,2-lift,false,stroke);
    water(g,9,t);
    if (active && lift===0) { g[8][Math.floor(width/2)-9]='.'; g[8][Math.floor(width/2)+8]="'"; }
  } else if (id === 'd') {
    const depth = active ? Math.round((Math.sin(t*.6)+1)*.7) : 0;
    stamp(g,whale,width-29,depth,false,stroke);
    if (depth) { g[1][1]='o'; g[3][3]='.'; }
  } else if (id === 'e') {
    stamp(g,whale,width/2-28+Math.sin(t*.55)*2,0,false,stroke);
    stamp(g,calf,width/2+9+Math.sin(t*.55-.7)*2,3,false,stroke);
  } else {
    const span=Math.max(1,width-25), position=active?(t*2.4)%(span*2):span*.35, reverse=position>span;
    stamp(g,small,reverse?span*2-position:position,0,reverse,stroke);
  }
  return g.map(row=>row.join('')).join('\n');
}
