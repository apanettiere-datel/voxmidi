import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import AuthProvider from './components/voxmidi/AuthProvider'
import { AuthFetchProvider } from './lib/authFetch.jsx'
import { JobsProvider } from './lib/JobsContext.jsx'
import './app.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AuthFetchProvider>
          <JobsProvider>
            <App />
          </JobsProvider>
        </AuthFetchProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)
