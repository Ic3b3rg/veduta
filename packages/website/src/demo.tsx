import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { catalogCssText, precisionToolCssText } from '@veduta/catalog'
import { Demo } from './demo-app.tsx'
import '@veduta/pwa/app.css'
import './demo.css'

const tokens = document.createElement('style')
tokens.textContent = catalogCssText() + precisionToolCssText()
document.head.append(tokens)
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <Demo />
  </HashRouter>,
)
