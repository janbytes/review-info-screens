/**
 * Handles all driver management socket events: add, edit, remove.
 * Includes automatic car number assignment when no car is manually selected.
 */

const MAX_CARS = 8;

// Finds lowest available car number in a session and fills gaps (if car 2 is removed the next driver will get it)
function getNextAvailableCar(session) {
    const usedCars = session.drivers.map(d => d.car);
    for (let i = 1; i <= MAX_CARS; i++) {
        if (!usedCars.includes(i)) return i;
    }
    return null;
}


function register(io, db, saveData) {
    io.on('connection', (socket) => {

        // Handle driver addition with optional manual car assignment
        socket.on('driver:add', (data) => {
            const { sessionId, driverName, carNumber } = data; // Received optional carNumber
            const session = db.sessions.find(s => s.id === sessionId);

            if (!session) {
                socket.emit('driver:error', { message: 'Session not found!' });
                return;
            }
            // Drivers cannot be added if the race is not in 'pending' status
            if (session.status !== 'pending') {
                socket.emit('driver:error', { message: 'Registration is closed. The race is already prepared or active!' });
                return;
            }

            // Driver name must be unique within the session
            const exists = session.drivers.find(
                d => d.name.toLowerCase() === driverName.toLowerCase()
            );
            if (exists) {
                socket.emit('driver:error', { message: 'Driver name already exists in this session!' });
                return;
            }

            let assignedCar;

            // Check if a manual car number was provided
            if (carNumber !== null && carNumber !== undefined) {
                const carInt = parseInt(carNumber);

                // Validate if car is within the allowed range (1-8)
                if (carInt < 1 || carInt > 8) {
                    socket.emit('driver:error', { message: 'Invalid car number! Must be 1-8.' });
                    return;
                }

                // Check if the manually selected car is already occupied
                const isTaken = session.drivers.find(d => d.car === carInt);
                if (isTaken) {
                    socket.emit('driver:error', { message: `Car ${carInt} is already taken!` });
                    return;
                }
                assignedCar = carInt;
            } else {
                // Fallback to automatic assignment if no car was specified
                assignedCar = getNextAvailableCar(session);
                if (assignedCar === null) {
                    socket.emit('driver:error', { message: 'Race is full! No cars available.' });
                    return;
                }
            }

            // Add driver with the assigned car
            session.drivers.push({ name: driverName, car: assignedCar });
            saveData(db);
            socket.emit('driver:success', { message: 'Driver added successfully' });
            io.emit('data:updated', db.sessions);
        });

        // Edit an existing driver's name and/or car number
        socket.on('driver:edit', (data) => {
            const { sessionId, oldName, newName, newCar } = data;
            const session = db.sessions.find(s => s.id === sessionId);

            if (!session) {
                socket.emit('driver:error', { message: 'Session not found!' });
                return;
            }
            if (session.status !== 'pending') {
                socket.emit('driver:error', { message: 'Cannot edit driver. The session is already in progress!' });
                return;
            }

            const driver = session.drivers.find(d => d.name.toLowerCase() === oldName.toLowerCase());
            if (!driver) {
                socket.emit('driver:error', { message: 'Driver not found!' });
                return;
            }

            // Check new name doesn't conflict with another driver
            if (newName && newName.toLowerCase() !== oldName.toLowerCase()) {
                const nameExists = session.drivers.find(d => d.name.toLowerCase() === newName.toLowerCase());
                if (nameExists) {
                    socket.emit('driver:error', { message: 'Driver name already exists in this session!' });
                    return;
                }
            }

            // Validate and check new car number
            if (newCar !== null && newCar !== undefined) {
                const carInt = parseInt(newCar);
                if (carInt < 1 || carInt > 8) {
                    socket.emit('driver:error', { message: 'Invalid car number! Must be 1-8.' });
                    return;
                }
                const isTaken = session.drivers.find(d => d.car === carInt && d.name.toLowerCase() !== oldName.toLowerCase());
                if (isTaken) {
                    socket.emit('driver:error', { message: `Car ${carInt} is already taken!` });
                    return;
                }
                driver.car = carInt;
            }

            if (newName) driver.name = newName;

            saveData(db);
            socket.emit('driver:success', { message: 'Driver updated successfully' });
            io.emit('data:updated', db.sessions);
        });

        // Handle driver removal
        socket.on('driver:remove', (data) => {
            const { sessionId, driverName } = data;
            const session = db.sessions.find(s => s.id === sessionId);

            if (!session) {
                socket.emit('driver:error', { message: 'Session not found!' });
                return;
            }
            // Drivers cannot be removed if the race is not in 'pending' status
            if (session.status !== 'pending') {
                socket.emit('driver:error', { message: 'Cannot remove driver. The session is already in progress!' });
                return;
            }

            session.drivers = session.drivers.filter(
                d => d.name.toLowerCase() !== driverName.toLowerCase()
            );
            saveData(db);
            io.emit('data:updated', db.sessions);
        });

    });
}

module.exports = { register, getNextAvailableCar };
