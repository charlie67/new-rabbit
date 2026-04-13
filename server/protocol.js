// Message types for WebSocket communication between server and client
// Binary WebSocket frames are used for media (WebM chunks) — no type field needed

export const MSG = {
  // Server -> Client
  WELCOME:          'welcome',
  USER_LIST:        'userList',
  CONTROL_GRANTED:  'controlGranted',
  CONTROL_RELEASED: 'controlReleased',
  NAV_RESULT:       'navResult',
  URL_CHANGED:      'urlChanged',
  ERROR:            'error',

  // Client -> Server
  SET_NICKNAME:     'setNickname',
  REQUEST_CONTROL:  'requestControl',
  RELEASE_CONTROL:  'releaseControl',
  NAVIGATE:         'navigate',
  NAV_BACK:         'navBack',
  NAV_FORWARD:      'navForward',
  MOUSE_EVENT:      'mouseEvent',
  KEY_EVENT:        'keyEvent',
  WHEEL_EVENT:      'wheelEvent',
};
