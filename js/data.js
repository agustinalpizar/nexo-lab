// DATOS DE DEMOSTRACIÓN. Nada aquí viene de máquinas reales: edita este archivo para probar el panel.
//
// Máquina: {
//   id, name, kind: 'host' | 'vm', os, ip, state, cpu, mem, disk, services, note?,
//   platform  hipervisor de la VM, o rol del equipo principal
//   vcpu, ramGB, diskGB   capacidad asignada
//   uptime    texto libre ('3 d 4 h'); null si está apagada
// }
//   state:            'running' (activa) | 'stopped' (apagada) | 'alert' (con alertas)
//   cpu, mem, disk:   porcentaje 0-100; cpu y mem son null si la máquina está apagada
//   services:         [{ name, status: 'ok' | 'warn' | 'down', port? }]
// Actividad: { time: 'HH:MM', type: 'alert' | 'on' | 'off' | 'info', machine: id, text }
(function (root) {
  root.NEXO_DATA = {
    isDemo: true,
    labName: 'Nexo Lab',
    machines: [
      {
        id: 'host', name: 'Equipo principal', kind: 'host', os: 'Windows 11 Home', ip: '192.168.1.10',
        platform: 'Anfitrión de las máquinas virtuales', vcpu: 12, ramGB: 32, diskGB: 1000, uptime: '6 d 2 h',
        state: 'running', cpu: 23, mem: 61, disk: 58,
        services: [{ name: 'VirtualBox', status: 'ok' }, { name: 'Docker Desktop', status: 'ok' }]
      },
      {
        id: 'ubuntu', name: 'Ubuntu Server', kind: 'vm', os: 'Ubuntu Server 24.04 LTS', ip: '192.168.56.11',
        platform: 'VirtualBox', vcpu: 2, ramGB: 4, diskGB: 40, uptime: '3 d 4 h',
        state: 'running', cpu: 12, mem: 38, disk: 41,
        services: [{ name: 'SSH', status: 'ok', port: 22 }, { name: 'Nginx', status: 'ok', port: 80 }, { name: 'Docker', status: 'ok' }]
      },
      {
        id: 'kali', name: 'Kali Linux', kind: 'vm', os: 'Kali Linux 2025.3', ip: '192.168.56.12',
        platform: 'VirtualBox', vcpu: 2, ramGB: 4, diskGB: 80, uptime: null,
        state: 'stopped', cpu: null, mem: null, disk: 63,
        services: [{ name: 'SSH', status: 'down', port: 22 }]
      },
      {
        id: 'winlab', name: 'Windows Lab', kind: 'vm', os: 'Windows Server 2022', ip: '192.168.56.20',
        platform: 'VirtualBox', vcpu: 4, ramGB: 8, diskGB: 60, uptime: '1 d 7 h',
        state: 'alert', cpu: 87, mem: 92, disk: 77,
        services: [{ name: 'RDP', status: 'ok', port: 3389 }, { name: 'Active Directory', status: 'warn' }, { name: 'DNS', status: 'ok', port: 53 }],
        note: 'Memoria por encima del 90 %'
      },
      {
        id: 'wazuh', name: 'Wazuh Manager', kind: 'vm', os: 'Ubuntu 22.04 LTS', ip: '192.168.56.30',
        platform: 'VirtualBox', vcpu: 4, ramGB: 8, diskGB: 100, uptime: '1 h 25 min',
        state: 'running', cpu: 34, mem: 72, disk: 52,
        services: [{ name: 'wazuh-manager', status: 'ok', port: 1514 }, { name: 'Dashboard', status: 'ok', port: 443 }, { name: 'Indexer', status: 'ok', port: 9200 }]
      },
      {
        id: 'files', name: 'Servidor de archivos', kind: 'vm', os: 'Debian 12', ip: '192.168.56.40',
        platform: 'VirtualBox', vcpu: 1, ramGB: 2, diskGB: 250, uptime: null,
        state: 'stopped', cpu: null, mem: null, disk: 34,
        services: [{ name: 'Samba', status: 'down', port: 445 }, { name: 'SSH', status: 'down', port: 22 }]
      }
    ],
    activity: [
      { time: '16:32', type: 'alert', machine: 'winlab', text: 'Windows Lab superó el 90 % de memoria' },
      { time: '15:58', type: 'on', machine: 'wazuh', text: 'Wazuh Manager reanudado' },
      { time: '14:20', type: 'off', machine: 'kali', text: 'Kali Linux apagada' },
      { time: '13:05', type: 'info', machine: 'ubuntu', text: 'Ubuntu Server: actualización de paquetes completada' },
      { time: '09:41', type: 'off', machine: 'files', text: 'Servidor de archivos apagado' }
    ]
  };
})(typeof self !== 'undefined' ? self : this);
