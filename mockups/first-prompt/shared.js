import { whaleFrame, finFrame } from './variants.js';

const sample = { prompt:'fix the database query timeout', reply:'I’ll inspect the query wrapper and connection settings, then run the relevant checks.' };
const template = `
  <div class="terminal" data-state="new">
    <header class="term-header">
      <div class="brand-row"><span class="wordmark">orca</span><span class="project">› [phoebe]</span><button type="button" class="reset">+ new chat</button></div>
      <div class="metadata">
        <div class="meta-text"><div class="model">gpt-6-astra · medium · fast off</div><div><span class="context">ctx 0 / 272k</span> · review rounds: 1</div><div>~/documents/phoebe/phoebe</div></div>
        <div class="fin-space" role="img" aria-label="Swimming orca fin in waves"><pre class="fin" aria-hidden="true"></pre></div>
      </div>
    </header>
    <div class="conversation">
      <div class="welcome"><div role="img" aria-label="Animated ASCII orca"><pre class="whale" aria-hidden="true"></pre></div><div class="welcome-label"><strong>orca</strong>what are we working on?</div></div>
      <div class="chat" hidden><div class="prompt"></div><div class="reply"></div><div class="activity">⏺ looking through the project…</div></div>
    </div>
    <div class="composer-area">
      <div class="composer" role="group" aria-label="Send the first prompt"><span aria-hidden="true">&gt;</span><input aria-label="Message orca" maxlength="500" placeholder="Ask orca to build, fix, or explore…"><button class="send" type="button">send ↵</button></div>
      <div class="footer"><div class="footer-info"><span class="agents">0 agents running</span><span>│ 0 messages queued</span><span>│ inbox 0</span></div><button class="stop" type="button" hidden>stop</button></div>
    </div>
  </div>`;

export function mountGallery(variants) {
  const demos=[];
  let paused=matchMedia('(prefers-reduced-motion: reduce)').matches, tick=0;
  const gallery=document.getElementById('gallery'), letters=document.getElementById('letters');
  for(const variant of variants) {
    const link=document.createElement('a'); link.href='#'+variant.id; link.textContent=variant.id.toUpperCase(); link.setAttribute('aria-label',variant.name); letters.append(link);
    const section=document.createElement('section'); section.className='choice'; section.id=variant.id;
    section.innerHTML=`<div class="choice-heading"><span class="letter">${variant.id.toUpperCase()}</span><div><h2>${variant.name}</h2><p>${variant.idea}</p></div></div>`+template;
    gallery.append(section);
    const query=selector=>section.querySelector(selector), terminal=query('.terminal');
    const input=query('input'), whale=query('.whale'), fin=query('.fin');
    const demo={section,variant,started:false,busy:false,visible:true,start:0,send,reset,draw}; demos.push(demo);
    input.value=sample.prompt; input.setAttribute('aria-label',variant.id.toUpperCase()+' · Message orca');
    query('.reset').setAttribute('aria-label',variant.id.toUpperCase()+' · new chat');
    query('.send').setAttribute('aria-label',variant.id.toUpperCase()+' · send first prompt');
    query('.stop').setAttribute('aria-label',variant.id.toUpperCase()+' · stop');
    function paint() {
      terminal.dataset.state=demo.started?'chat':'new';
      query('.welcome').hidden=demo.started; query('.chat').hidden=!demo.started;
      query('.stop').hidden=!demo.busy; query('.fin-space').setAttribute('aria-hidden',String(!demo.started));
      query('.context').textContent=demo.started?'ctx 2k / 272k':'ctx 0 / 272k';
      query('.agents').textContent=demo.busy?'1 agent running':'0 agents running';
      query('.activity').textContent=demo.busy?'⏺ looking through the project…':'ready for your next message';
      draw();
    }
    function send(all=false) {
      const prompt=all?sample.prompt:input.value.trim(); if(!prompt) return;
      demo.started=true; demo.busy=true; demo.start=tick;
      query('.prompt').textContent='> '+prompt; query('.reply').textContent=sample.reply; input.value=''; paint();
    }
    function reset() {demo.started=false;demo.busy=false;demo.start=tick;input.value=sample.prompt;paint();}
    function draw() {
      const age=tick-demo.start;
      if(!demo.started) {
        const cols=Math.max(30,Math.floor(whale.clientWidth/6.63));
        whale.textContent=whaleFrame(variant,age,cols);
      } else if(demo.busy||!fin.textContent) {
        const cols=Math.max(24,Math.floor(query('.fin-space').clientWidth/7.24));
        fin.textContent=finFrame(variant,age,cols);
      }
    }
    query('.send').addEventListener('click',()=>send());
    input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();send();}});
    query('.reset').addEventListener('click',reset);
    query('.stop').addEventListener('click',()=>{demo.busy=false;paint();});
    new ResizeObserver(draw).observe(terminal);
    new IntersectionObserver(entries=>{demo.visible=entries.some(entry=>entry.isIntersecting);if(demo.visible)draw();}).observe(section);
    paint();
  }
  document.getElementById('all-new').addEventListener('click',()=>demos.forEach(demo=>demo.reset()));
  document.getElementById('all-sent').addEventListener('click',()=>demos.forEach(demo=>demo.send(true)));
  const motion=document.getElementById('motion');
  const motionLabel=()=>{motion.textContent=paused?'play motion':'pause motion';motion.setAttribute('aria-pressed',String(!paused));};
  motion.addEventListener('click',()=>{paused=!paused;motionLabel();}); motionLabel();
  setInterval(()=>{if(paused||document.hidden)return;tick++;demos.forEach(demo=>{if(demo.visible)demo.draw();});},180);
}
