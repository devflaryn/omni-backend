import crypto from 'crypto';

// No 0/O or 1/I: both are easy to mistype/misread when a key is read off a
// screen or dictated over chat, which is how these will actually change hands.
const GROUP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUP_COUNT = 3;
const GROUP_LENGTH = 4;

function randomGroup() {
    let group = '';
    const bytes = crypto.randomBytes(GROUP_LENGTH);
    for (let i = 0; i < GROUP_LENGTH; i++) {
        group += GROUP_CHARS[bytes[i] % GROUP_CHARS.length];
    }
    return group;
}

export function generateKeyCode() {
    const groups = Array.from({ length: GROUP_COUNT }, randomGroup);
    return `OMNI-${groups.join('-')}`;
}
