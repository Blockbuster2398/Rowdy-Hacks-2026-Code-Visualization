import { embedText } from '../embeddings/word2vec.js';
import './style.css';

const form = document.querySelector('#embedding-form');
const input = document.querySelector('#text-input');
const button = document.querySelector('#submit-button');
const status = document.querySelector('#status');
const output = document.querySelector('#output');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = 'Loading model and generating vector...';
  output.textContent = '';

  try {
    const vector = await embedText(input.value.trim());
    output.textContent = JSON.stringify(vector);
    status.textContent = `Vector has ${vector.length} values.`;
  } catch (error) {
    status.textContent = `Could not generate vector: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});