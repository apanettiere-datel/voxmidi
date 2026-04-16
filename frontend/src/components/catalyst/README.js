/*
 * ═══════════════════════════════════════════════════════
 *  CATALYST COMPONENTS GO HERE
 * ═══════════════════════════════════════════════════════
 *
 *  1. Download catalyst-ui-kit.zip from your Tailwind Plus account:
 *     https://tailwindui.com
 *
 *  2. Unzip and copy the JavaScript components into this folder:
 *     cp -r catalyst-ui-kit/javascript/* ./
 *
 *  3. You should end up with files like:
 *     - button.jsx
 *     - input.jsx
 *     - select.jsx
 *     - textarea.jsx
 *     - fieldset.jsx
 *     - badge.jsx
 *     - dialog.jsx
 *     - dropdown.jsx
 *     - heading.jsx
 *     - sidebar.jsx
 *     - sidebar-layout.jsx
 *     - navbar.jsx
 *     - stacked-layout.jsx
 *     - table.jsx
 *     - avatar.jsx
 *     - link.jsx
 *     - description-list.jsx
 *     - divider.jsx
 *     - text.jsx
 *     - listbox.jsx
 *     - combobox.jsx
 *     - checkbox.jsx
 *     - radio.jsx
 *     - switch.jsx
 *     - alert.jsx
 *     - pagination.jsx
 *
 *  4. Then go to App.jsx and uncomment the Catalyst SidebarLayout
 *     version of AppLayout (it's clearly marked in the code).
 *
 *  5. Update link.jsx to use react-router-dom's Link:
 *
 *     import { Link as RouterLink } from 'react-router-dom'
 *     import * as Headless from '@headlessui/react'
 *     import React, { forwardRef } from 'react'
 *
 *     export const Link = forwardRef(function Link(props, ref) {
 *       return (
 *         <Headless.DataInteractive>
 *           <RouterLink {...props} ref={ref} />
 *         </Headless.DataInteractive>
 *       )
 *     })
 */
