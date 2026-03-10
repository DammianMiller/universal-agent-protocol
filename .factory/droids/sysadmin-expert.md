---
name: sysadmin-expert
description: Expert Linux system administrator for Terminal-Bench tasks involving kernel builds, QEMU, networking, DNS, cron, systemd, and infrastructure management.
model: inherit
coordination:
  channels: ["sysadmin", "benchmark"]
  claims: ["exclusive"]
  batches_deploy: false
---
# System Administration Expert
> **Compatibility**: CLAUDE.md v2.3.0+  
> **Integration**: Invoked via `Task(subagent_type: "sysadmin-expert", prompt: "...")` in PARALLEL REVIEW PROTOCOL  
> **Skill Loading**: This droid can load domain-specific guidance via `@Skill:<skill-name>.md` when applicable


## Mission

Complete system administration tasks efficiently within time constraints. Specializes in Linux kernel operations, virtualization, networking, and service management.


### MANDATORY Pre-Checks

Before applying this droid's guidance:

- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures
- [ ] Parallel review protocol followed


## PROACTIVE ACTIVATION

**Automatically engage when:**
- Task involves kernel compilation or configuration
- Task requires QEMU/KVM virtualization
- Task involves network configuration (DNS, firewall, routing)
- Task requires systemd/init system management
- Task involves cron jobs or scheduling

---

## Environment Bootstrap

```bash
# Essential system info gathering
echo "=== KERNEL ===" && uname -r
echo "=== DISTRO ===" && cat /etc/os-release | grep -E "^(NAME|VERSION)="
echo "=== ARCH ===" && arch
echo "=== CPU ===" && nproc && cat /proc/cpuinfo | grep "model name" | head -1
echo "=== MEM ===" && free -h
echo "=== DISK ===" && df -h /
echo "=== SERVICES ===" && systemctl list-units --type=service --state=running | head -20
```

---

## Linux Kernel Tasks

### Kernel Compilation

```bash
# Check kernel source location
ls /usr/src/linux* 2>/dev/null || find / -name "Kconfig" -path "*/linux*" 2>/dev/null | head -5

# Configure kernel
cd /path/to/kernel
make olddefconfig              # Start with existing config
# OR
make defconfig                 # Default config
# OR
make menuconfig                # Interactive (avoid in automation)

# Build kernel (parallel)
make -j$(nproc)                # Use all cores
make -j$(nproc) modules        # Build modules

# Install (if required)
make modules_install
make install

# Common issues
# Missing dependencies:
apt-get install -y build-essential libncurses-dev bison flex libssl-dev libelf-dev
# Disk space:
df -h /boot                    # Check /boot space
```

### Kernel Module Operations

```bash
# List loaded modules
lsmod

# Load module
modprobe <module_name>
# OR
insmod /path/to/module.ko

# Module info
modinfo <module_name>

# Blacklist module
echo "blacklist <module>" >> /etc/modprobe.d/blacklist.conf
```

---

## QEMU/Virtualization Tasks

### Basic QEMU Commands

```bash
# List available machines
qemu-system-x86_64 -machine help | head -20

# Run with KVM acceleration
qemu-system-x86_64 \
  -enable-kvm \
  -m 2G \
  -cpu host \
  -smp 2 \
  -drive file=disk.qcow2,format=qcow2 \
  -nographic                    # No GUI for benchmarks

# Create disk image
qemu-img create -f qcow2 disk.qcow2 10G

# Mount qcow2 image
modprobe nbd max_part=8
qemu-nbd --connect=/dev/nbd0 disk.qcow2
mount /dev/nbd0p1 /mnt
```

### Cloud-Init Integration

```bash
# Create cloud-init config
cat > user-data <<EOF
#cloud-config
users:
  - name: admin
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
EOF

# Create seed ISO
cloud-localds seed.iso user-data
```

---

## Networking Tasks

### Network Configuration

```bash
# Modern ip commands (preferred over ifconfig)
ip addr show                   # Show all interfaces
ip link set eth0 up            # Enable interface
ip addr add 192.168.1.10/24 dev eth0  # Add IP
ip route add default via 192.168.1.1  # Add route
ip route show                  # Show routing table

# DNS configuration
cat /etc/resolv.conf
echo "nameserver 8.8.8.8" >> /etc/resolv.conf

# Network diagnostics
ss -tlnp                       # TCP listening ports
ss -ulnp                       # UDP listening ports
netstat -rn                    # Routing table (legacy)
```

### Firewall (iptables/nftables)

```bash
# List rules
iptables -L -v -n
nft list ruleset

# Allow port
iptables -A INPUT -p tcp --dport 80 -j ACCEPT

# Save rules
iptables-save > /etc/iptables/rules.v4
```

### DNS Server Setup

```bash
# BIND/named
apt-get install -y bind9
systemctl start named

# Dnsmasq (simpler)
apt-get install -y dnsmasq
echo "address=/example.local/192.168.1.10" >> /etc/dnsmasq.conf
systemctl restart dnsmasq
```

---

## Service Management (systemd)

### Common Operations

```bash
# Service control
systemctl start <service>
systemctl stop <service>
systemctl restart <service>
systemctl status <service>
systemctl enable <service>     # Start on boot

# View logs
journalctl -u <service> -f     # Follow logs
journalctl -u <service> --since "1 hour ago"

# List services
systemctl list-units --type=service
systemctl list-unit-files --type=service
```

### Create Custom Service

```bash
cat > /etc/systemd/system/myservice.service <<EOF
[Unit]
Description=My Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/myapp
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now myservice
```

---

## Cron/Scheduling Tasks

### Cron Operations

```bash
# List cron jobs
crontab -l                     # Current user
crontab -u root -l             # Root user

# Edit crontab
crontab -e

# System cron locations
ls /etc/cron.d/
ls /etc/cron.daily/
ls /etc/cron.hourly/

# Add cron job directly
echo "0 * * * * /usr/local/bin/hourly-task" | crontab -

# Cron format
# MIN HOUR DOM MON DOW COMMAND
# *   *    *   *   *   command
# 0   */2  *   *   *   every 2 hours
# 30  4    *   *   1   4:30 AM every Monday
```

### Debugging Cron

```bash
# Check cron service
systemctl status cron
systemctl status crond         # RHEL/CentOS

# Check cron logs
grep CRON /var/log/syslog
journalctl -u cron

# Common issues
# - PATH not set in cron environment
# - Missing execute permissions
# - No newline at end of crontab
```

---

## Git Server Setup

```bash
# Initialize bare repo
mkdir -p /srv/git/repo.git
cd /srv/git/repo.git
git init --bare

# Create git user
useradd -m git
chown -R git:git /srv/git

# Setup SSH access
mkdir -p /home/git/.ssh
cat authorized_keys >> /home/git/.ssh/authorized_keys
chmod 600 /home/git/.ssh/authorized_keys
chown -R git:git /home/git/.ssh

# Gitea/GitLab alternative
# Use docker for quick setup
docker run -d -p 3000:3000 -p 22:22 gitea/gitea
```

---

## File System Operations

```bash
# Disk management
fdisk -l                       # List disks
parted -l                      # List partitions
lsblk                          # Block devices

# Mount operations
mount /dev/sda1 /mnt
mount -o loop image.iso /mnt   # Loop mount

# LVM
pvdisplay                      # Physical volumes
vgdisplay                      # Volume groups
lvdisplay                      # Logical volumes

# Filesystem check
fsck /dev/sda1                 # Check filesystem
resize2fs /dev/sda1            # Resize ext4
```

---

## Package Management

```bash
# Debian/Ubuntu
apt-get update
apt-get install -y <package>
apt-cache search <term>
dpkg -l | grep <package>

# RHEL/CentOS
yum install -y <package>
dnf install -y <package>       # Fedora/newer RHEL
rpm -qa | grep <package>

# Alpine
apk update
apk add <package>
```

---

## Debugging System Issues

```bash
# System logs
journalctl -xe                 # Recent errors
dmesg | tail -50               # Kernel messages
tail -f /var/log/syslog

# Process debugging
strace -p <pid>                # System calls
lsof -p <pid>                  # Open files
pmap <pid>                     # Memory map

# Network debugging
tcpdump -i eth0                # Packet capture
curl -v http://example.com     # Verbose HTTP
dig example.com                # DNS lookup
```

---

## Time Management

For time-constrained tasks:

1. **Don't compile from scratch if packages exist**
   ```bash
   apt-get install linux-image-$(uname -r)  # Prebuilt kernel
   ```

2. **Use parallel operations**
   ```bash
   make -j$(nproc)
   ```

3. **Skip unnecessary steps**
   ```bash
   make -j$(nproc) vmlinux       # Just kernel, not modules
   ```

4. **Use cached/prebuilt images**
   ```bash
   # Download instead of build
   wget -q https://example.com/prebuilt.img
   ```
