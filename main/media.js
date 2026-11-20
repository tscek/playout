'use strict';
const path = require('path');
const crypto = require('crypto');

const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.mxf', '.m4v', '.mpg', '.mpeg', '.ts', '.m2ts', '.wmv', '.flv'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.tif', '.tiff', '.gif', '.webp'];
const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.wma', '.aif', '.aiff'];

function mediaType(file) {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function makeItem(file) {
  const type = mediaType(file);
  if (!type) return null;
  return {
    id: newId(),
    path: file,
    name: path.basename(file),
    type,
  };
}

const ALL_EXT = [...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT].map((e) => e.slice(1));

module.exports = { mediaType, makeItem, newId, ALL_EXT, VIDEO_EXT, IMAGE_EXT, AUDIO_EXT };
