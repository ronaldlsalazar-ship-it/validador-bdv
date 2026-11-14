// Borra la carpeta de autenticación
const fs = require('fs');
const path = require('path');

const authFolder = './auth_info'; // o donde guardes tu sesión
if (fs.existsSync(authFolder)) {
    fs.rmSync(authFolder, { recursive: true, force: true });
}