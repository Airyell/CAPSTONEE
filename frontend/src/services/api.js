import axios from 'axios';

const api = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL ||
        'https://regisscan.onrender.com/api',

    headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    },
});

export default api;