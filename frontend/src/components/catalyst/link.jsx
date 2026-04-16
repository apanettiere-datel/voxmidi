import * as Headless from '@headlessui/react'
import { Link as RouterLink } from 'react-router-dom'
import React, { forwardRef } from 'react'

export const Link = forwardRef(function Link({ href, ...props }, ref) {
  // External URLs and hash links use plain <a>, internal paths use RouterLink
  if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:')) {
    return (
      <Headless.DataInteractive>
        <a href={href} {...props} ref={ref} />
      </Headless.DataInteractive>
    )
  }
  return (
    <Headless.DataInteractive>
      <RouterLink to={href} {...props} ref={ref} />
    </Headless.DataInteractive>
  )
})
