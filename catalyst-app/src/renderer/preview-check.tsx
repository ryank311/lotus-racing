import React, {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Sessions} from './pages/Sessions'
import {Analysis} from './pages/Analysis'
import {Sidebar} from './components/Sidebar'
import {UnitsProvider} from './units'
import './styles.css'
function Preview(){const [selected,setSelected]=useState(new Set<string>());const [page,setPage]=useState('sessions');return <UnitsProvider><div className="app-shell"><Sidebar active={page as any} onChange={setPage} connected signedIn email={null} onSignIn={()=>{}}/><div className="main-pane">{page==='analysis'?<Analysis selected={selected} setSelected={setSelected} onBack={()=>setPage('sessions')}/>:<Sessions refreshTick={0} selected={selected} setSelected={setSelected} activeAccount={null} onAnalyze={()=>setPage('analysis')} onEnsureSessions={(window as any).previewEnsure}/>}</div></div></UnitsProvider>}
createRoot(document.getElementById('root')!).render(<Preview/>);
