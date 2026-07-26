#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, IntoVal};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Registry,
    Count(Address),
    Total,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum BuilderStreakError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    RegistryRejected = 3,
}

#[contract]
pub struct BuilderStreak;

#[contractimpl]
impl BuilderStreak {
    pub fn initialize(env: Env, registry: Address) -> Result<(), BuilderStreakError> {
        if env.storage().instance().has(&DataKey::Registry) {
            return Err(BuilderStreakError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage().instance().set(&DataKey::Total, &0u32);
        Ok(())
    }

    pub fn increment(env: Env, builder: Address) -> Result<u32, BuilderStreakError> {
        builder.require_auth();
        let registry: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(BuilderStreakError::NotInitialized)?;
        let current: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Count(builder.clone()))
            .unwrap_or(0);
        let next = current.saturating_add(1);
        env.storage()
            .persistent()
            .set(&DataKey::Count(builder.clone()), &next);
        let total: u32 = env.storage().instance().get(&DataKey::Total).unwrap_or(0);
        env.storage().instance().set(&DataKey::Total, &total.saturating_add(1));
        env.events().publish((symbol_short!("activity"), builder.clone()), next);

        env.invoke_contract::<()>(
            &registry,
            &soroban_sdk::Symbol::new(&env, "record_activity"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                builder.into_val(&env),
                next.into_val(&env),
            ],
        );
        Ok(next)
    }

    pub fn get_count(env: Env, builder: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Count(builder))
            .unwrap_or(0)
    }

    pub fn get_total(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Total).unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use badge_registry::{BadgeRegistry, BadgeRegistryClient};
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn increments_and_notifies_registry() {
        let env = Env::default();
        env.mock_all_auths();
        let registry_id = env.register(BadgeRegistry, ());
        let streak_id = env.register(BuilderStreak, ());
        let registry = BadgeRegistryClient::new(&env, &registry_id);
        let streak = BuilderStreakClient::new(&env, &streak_id);
        let builder = Address::generate(&env);

        registry.initialize(&streak_id);
        streak.initialize(&registry_id);
        assert_eq!(streak.increment(&builder), 1);
        assert_eq!(streak.increment(&builder), 2);
        assert_eq!(streak.get_count(&builder), 2);
        assert_eq!(registry.get_badge(&builder), 0);
    }
}
