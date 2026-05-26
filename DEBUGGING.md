# DEBUGGING

## VS Code Plugin Webview

Here's how to open the DevTools specifically for the Static Analysis webview:

  1. Click inside the Static Analysis panel to give it focus (click anywhere in the white content area)
  2. Open Command Palette: Cmd+Shift+P
  3. Type Open Webview Developer Tools and press Enter

  A Chromium DevTools window will pop up. Once it's open:

  1. Click the Console tab
  2. Look for any red error messages 

## VS Code Backend Code

Once the extension is installed execute the following:

    1. Open a terminal
    2. Select Output
    3. In the Dropdown on the top right select "Incident Investigator"
    4. The server logs will appear there

## Chrome Plugin

To debug the communication with the Chrome Plugin to the VS Code Extension do the following:

    1. Go to chrome://extensions
    2. Find the "Incident Investigator Bridge"
    3. Then select the "service worker" option
    4. A Chrome developer console will open for you to review the logs and network calls