import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<textarea id="cfg-roletext">旧人设</textarea><textarea id="cfg-customrules"></textarea><textarea id="cfg-sysprompt">旧提示词</textarea><select id="cfg-participation"><option value="medium" selected>普通</option><option value="high">活跃</option></select><input id="cfg-persona-unified" type="checkbox" checked>`);
const old = {persona:{roleText:'旧人设',customRules:'',systemPromptOverride:'旧提示词',participation:'medium'},personaUnified:true};
const server = {persona:{...old.persona,roleText:'温和人设',customRules:'不要顶嘴',systemPromptOverride:'温和提示词'},personaUnified:true};
const requests=[];
let duringRequest=()=>{};
const context=vm.createContext({document:dom.window.document,state:{config:structuredClone(old),settingsSection:'persona'},api:async(_,opts)=>{
  const patch=JSON.parse(opts.body);requests.push(patch);Object.assign(server.persona,patch.persona);if('personaUnified' in patch)server.personaUnified=patch.personaUnified;
  duringRequest();return {ok:true,config:structuredClone(server)};
}});
vm.runInContext(fs.readFileSync(new URL('../ui/app/08-modals.js',import.meta.url),'utf8'),context);
const save=()=>vm.runInContext('saveConfig({quiet:true})',context);
await save();assert.equal(requests.length,0,'切页或刷新时未改动的旧表单不得回写');
dom.window.document.querySelector('#cfg-participation').value='high';await save();
assert.deepEqual(requests[0],{persona:{participation:'high'}});
assert.equal(dom.window.document.querySelector('#cfg-roletext').value,'温和人设');
await save();assert.equal(requests.length,1,'响应同步后不得再次提交旧人设');
const role=dom.window.document.querySelector('#cfg-roletext');role.value='用户编辑一';
duringRequest=()=>{role.value='用户编辑二';};await save();assert.equal(role.value,'用户编辑二','保存期间的新输入不能被响应清掉');
duringRequest=()=>{};await save();assert.equal(server.persona.roleText,'用户编辑二');
const rules=dom.window.document.querySelector('#cfg-customrules');rules.value='';await save();assert.equal(server.persona.customRules,'','用户主动清空仍可保存');
console.log('✓ 人设增量保存：旧页面不回写、同步新配置、保留并发输入、允许主动清空');
