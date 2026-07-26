#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    StreakContract,
    Activity(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum BadgeRegistryError {
    AlreadyInitialized = 1,
    UnauthorizedCaller = 2,
}

#[contract]
pub struct BadgeRegistry;

#[contractimpl]
impl BadgeRegistry {
    pub fn initialize(env: Env, streak_contract: Address) -> Result<(), BadgeRegistryError> {
        if env.storage().instance().has(&DataKey::StreakContract) {
            return Err(BadgeRegistryError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::StreakContract, &streak_contract);
        Ok(())
    }

    pub fn record_activity(
        env: Env,
        caller: Address,
        builder: Address,
        count: u32,
    ) -> Result<(), BadgeRegistryError> {
        let streak: Address = env.storage().instance().get(&DataKey::StreakContract).unwrap();
        if caller != streak {
            return Err(BadgeRegistryError::UnauthorizedCaller);
        }
        caller.require_auth();
        env.storage().persistent().set(&DataKey::Activity(builder.clone()), &count);
        let badge = count / 3;
        env.events().publish((symbol_short!("badge"), builder), badge);
        Ok(())
    }

    pub fn get_badge(env: Env, builder: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Activity(builder))
            .unwrap_or(0)
            / 3
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn only_streak_contract_can_record() {
        let env = Env::default();
        env.mock_all_auths();
        let registry_id = env.register(BadgeRegistry, ());
        let registry = BadgeRegistryClient::new(&env, &registry_id);
        let streak = Address::generate(&env);
        let builder = Address::generate(&env);
        registry.initialize(&streak);
        assert_eq!(registry.get_badge(&builder), 0);
        registry.record_activity(&streak, &builder, &3);
        assert_eq!(registry.get_badge(&builder), 1);
    }
}
